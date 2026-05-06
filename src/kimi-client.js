import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const PROTOCOL_VERSION = process.env.KIMI_PROTOCOL_VERSION || '1.9';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const LOG_THINK = process.env.KIMI_LOG_THINK === '1';
// Idle timeouts: reset on every incoming line from kimi (see _onLine).
// A long-running `prompt` will only fire RPC_TIMEOUT_MS if kimi goes truly silent
// — not because the wall-clock total exceeds the cap.
const RPC_TIMEOUT_MS = Math.max(1000, parseInt(process.env.KIMI_RPC_TIMEOUT_MS || '600000', 10));
const RPC_FAST_TIMEOUT_MS = Math.max(1000, parseInt(process.env.KIMI_RPC_FAST_TIMEOUT_MS || '30000', 10));
const RPC_INIT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.KIMI_RPC_INIT_TIMEOUT_MS || '60000', 10));

const log = (msg) => process.stderr.write(`[kimicode-mcp] ${msg}\n`);

export function truncateResponse(text, cap) {
  if (text.length <= cap) return { text, truncated: false }
  const marker = `[kimi response truncated from ${text.length} to ${cap} chars by KIMI_MAX_RESPONSE_BYTES]`
  return { text: text.slice(0, cap) + '\n\n' + marker, truncated: true }
}

export class KimiClient {
  constructor({ args, cwd } = {}) {
    this.args = args || [];
    this.cwd = cwd;
    this.proc = null;
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
      return { protocol_version: 'fake' };
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
      const err = new Error(`kimi --wire exited (code=${code} signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.proc = null;
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));

    const result = await this._call('initialize', {
      protocol_version: PROTOCOL_VERSION,
      client: { name: 'kimicode-mcp', version: '0.2.0' },
    }, { timeoutMs: RPC_INIT_TIMEOUT_MS });
    log(`initialized server=${result?.server?.name}/${result?.server?.version} protocol=${result?.protocol_version}`);
    return result;
  }

  _onLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return; }

    // Any line from kimi means it's alive — refresh idle timers for all in-flight calls.
    // Without this, a long-running `prompt` that's actively streaming events would
    // still hit the wall-clock timeout and get killed mid-task.
    for (const p of this.pending.values()) p.refresh?.();

    const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
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
      log(`reverse request rejected: ${msg.method}`);
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `client (${msg.method}) not implemented` },
      });
      return;
    }

    if (isNotification) {
      for (const fn of this.eventListeners) {
        try { fn(msg); } catch (e) { log(`listener error: ${e.message}`); }
      }
    }
  }

  _send(obj) {
    if (!this.proc) throw new Error('kimi process not started');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _call(method, params, { timeoutMs } = {}) {
    const id = randomUUID();
    const cap = timeoutMs ?? (method === 'prompt' ? RPC_TIMEOUT_MS : RPC_FAST_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      // Idle timer: fires only when kimi has been silent for `cap` ms.
      // _onLine() refreshes this timer on every incoming line, so a long-running
      // `prompt` that's actively streaming will not be killed mid-task.
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

  async setPlanMode(enabled) {
    return this._call('set_plan_mode', { enabled: !!enabled });
  }

  runTurn({ userInput, planMode = false, onEvent } = {}) {
    const run = async () => {
      await this.start();
      let enabledHere = false;
      try {
        if (planMode) {
          try {
            await this.setPlanMode(true);
            enabledHere = true;
          } catch (e) {
            this.shutdown();
            throw new Error(`plan_mode enable failed, turn aborted: ${e.message}`);
          }
        }
        const chunks = [];
        let lastStatus = null;
        const listener = (msg) => {
          if (msg.method !== 'event') return;
          const p = msg.params || {};
          if (p.type === 'ContentPart') {
            const payload = p.payload || {};
            if (payload.type === 'text' && typeof payload.text === 'string') {
              chunks.push(payload.text);
            } else if (payload.type === 'think' && LOG_THINK && typeof payload.think === 'string') {
              log(`think: ${payload.think.slice(0, 120).replace(/\n/g, ' ')}…`);
            }
          } else if (p.type === 'StatusUpdate') {
            lastStatus = p.payload || null;
          }
          onEvent?.(msg);
        };
        this.eventListeners.add(listener);
        let result;
        try {
          result = await this._call('prompt', { user_input: userInput });
        } finally {
          this.eventListeners.delete(listener);
        }
        return {
          status: result?.status ?? 'unknown',
          steps: result?.steps,
          text: chunks.join(''),
          status_update: lastStatus,
        };
      } finally {
        if (enabledHere) {
          try {
            await this.setPlanMode(false);
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

  async cancel() {
    if (!this.proc || this.dead) return;
    try { await this._call('cancel', {}, { timeoutMs: RPC_FAST_TIMEOUT_MS }); }
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

  _buildArgs(workDir, maxSteps, allowedDirs = []) {
    const args = ['--yolo'];
    if (workDir) args.push('--work-dir', workDir);
    for (const d of allowedDirs) args.push('--add-dir', d);
    if (maxSteps) args.push('--max-steps-per-turn', String(maxSteps));
    args.push('--wire');
    return args;
  }

  get({ workDir, maxSteps, allowedDirs = [] } = {}) {
    const key = workDir || '';
    let entry = this.buckets.get(key);
    if (entry && entry.client.dead) {
      this.buckets.delete(key);
      entry = null;
    }
    if (!entry) {
      const sortedAllowed = [...allowedDirs].sort();
      const client = new KimiClient({
        args: this._buildArgs(workDir, maxSteps, sortedAllowed),
        cwd: workDir,
      });
      entry = { client, allowedDirs: sortedAllowed, maxSteps: maxSteps ?? null };
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
