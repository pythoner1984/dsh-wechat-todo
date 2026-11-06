/**
 * Warm client for the Python read bridge.
 *
 * Opening the encrypted WeChat databases costs seconds, so the bridge process
 * is started once and kept alive. A crash or a silent death has to be
 * recoverable without restarting Harness, so every call goes through
 * `#ensure()` and a dead child is simply replaced.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Interpreters to try, most specific first.
 *
 * The reader virtualenv is what actually has `sqlcipher3` and `zstandard`
 * installed; a bare `python` almost never does, so it is only a last resort.
 */
export function interpreterCandidates() {
  const home = homedir();
  const out = [];
  const env = process.env.WECHAT_TODO_PYTHON;
  if (env) out.push(env);
  out.push(
    join(
      home,
      '.codex',
      'share',
      'wechat-intelligence-hub',
      'projects',
      'rion-wechat-reader',
      '.venv',
      'Scripts',
      'python.exe',
    ),
  );
  out.push(join(home, '.codex', 'share', 'wechat-intelligence-hub', 'projects', 'rion-wechat-reader', '.venv', 'bin', 'python'));
  out.push(process.platform === 'win32' ? 'python.exe' : 'python3');
  return out;
}

export function resolveInterpreter(candidates = interpreterCandidates()) {
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return null;
}

class BridgeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export class Sidecar {
  /**
   * @param {object} options
   * @param {string} options.script Absolute path to `bridge/server.py`.
   * @param {string} [options.python] Interpreter to run it with.
   * @param {number} [options.timeoutMs] Per-call ceiling.
   * @param {(line: string) => void} [options.onLog] Diagnostics sink.
   */
  constructor({ script, python, timeoutMs = 120000, onLog }) {
    this.script = script;
    // An explicit empty value means "there is no interpreter"; only an omitted
    // one falls back to discovery.
    this.python = python === undefined ? resolveInterpreter() : python;
    this.timeoutMs = timeoutMs;
    this.onLog = onLog || (() => {});
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.dead = false;
    this.stderrTail = [];
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  #ensure() {
    if (this.running) return this.child;
    if (!this.python) {
      throw new BridgeError('python-missing', 'No Python interpreter with the WeChat reader dependencies was found.');
    }
    const child = spawn(this.python, [this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail.push(String(chunk));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.#failAll('bridge-spawn-failed', error.message);
    });
    child.on('exit', (code, signal) => {
      // A child we already replaced (reset, restart) must not touch the calls
      // that belong to its successor.
      if (this.child !== child) return;
      this.child = null;
      const tail = this.stderrTail.join('').trim().split('\n').slice(-3).join(' | ');
      this.#failAll(
        'bridge-exited',
        `The WeChat reader bridge stopped (code ${code}${signal ? `, signal ${signal}` : ''}).${tail ? ` ${tail}` : ''}`,
      );
    });
    this.child = child;
    return child;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.#onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onLog(`bridge produced a non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.data);
    else {
      const error = message.error || {};
      entry.reject(new BridgeError(error.code || 'bridge-error', error.message || 'bridge failed'));
    }
  }

  #failAll(code, message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(code, message));
    }
    this.pending.clear();
  }

  /**
   * Send one command and await its reply.
   *
   * Declared `async` on purpose: a missing interpreter has to surface as a
   * rejection, not as a synchronous throw that skips the caller's `catch`.
   *
   * @param {string} cmd
   * @param {object} [args]
   */
  async call(cmd, args = {}) {
    const child = this.#ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('bridge-timeout', `The WeChat reader did not answer "${cmd}" in time.`));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BridgeError('bridge-write-failed', error.message));
      }
    });
  }

  /** Drop the child so the next call re-reads the databases from scratch. */
  async reset() {
    const child = this.child;
    this.child = null;
    this.#failAll('bridge-reset', 'The WeChat reader bridge was reset.');
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  dispose() {
    const child = this.child;
    this.child = null;
    this.#failAll('bridge-disposed', 'The plugin shut down.');
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

export { BridgeError };
