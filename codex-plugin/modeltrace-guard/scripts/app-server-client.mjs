import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readProtocolLines } from './protocol-lines.mjs';

export const CODEX_CLIENT_INFO = Object.freeze({ name: 'modeltrace_guard', version: '0.1.7' });

// Use Codex's own transport and configured account/provider, never a parallel
// hand-written Responses/Chat client. Do not print protocol history or stderr.
export async function codexExecutable(env = process.env) {
  if (env.MODELTRACE_CODEX_PATH) {
    if (!path.isAbsolute(env.MODELTRACE_CODEX_PATH)) throw new Error('MODELTRACE_CODEX_PATH must be an absolute executable path');
    await access(env.MODELTRACE_CODEX_PATH);
    return env.MODELTRACE_CODEX_PATH;
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const executable = path.join(root, entry.name, 'codex.exe');
      try { await access(executable); found.push(executable); } catch {}
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error('Multiple Codex runtimes found; set MODELTRACE_CODEX_PATH to the runtime used by this Codex app');
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

export class AppServerClient {
  constructor(child, protocolOptions = {}) {
    this.child = child; this.nextId = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false; this.allowedTurns = new Set(); this.failure = null;
    this.enforceAllowedTurns = protocolOptions.enforceAllowedTurns ?? true;
    const rejectPending = (error) => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        if (waiting.onAbort && waiting.signal) waiting.signal.removeEventListener('abort', waiting.onAbort);
        waiting.reject(error);
      }
      this.pending.clear();
    };
    const fail = (error) => {
      if (this.failure || this.closed) return;
      this.failure = error;
      rejectPending(error);
      this.lines?.close();
      try { child.kill('SIGTERM'); } catch {}
    };
    this.fail = fail;
    this.destroy = (error) => {
      fail(error || new Error('AppServerClient destroyed'));
      try { child.kill('SIGKILL'); } catch {}
    };
    this.exited = new Promise((resolve) => {
      const finish = () => {
        if (this.closed) return;
        this.closed = true; this.lines?.close();
        rejectPending(this.failure || new Error('Codex probe transport closed'));
        resolve();
      };
      child.once('exit', finish); child.once('error', finish);
    });
    this.lines = readProtocolLines(child.stdout, (message) => {
      const waiting = this.pending.get(message.id);
      if (waiting && !message.method) {
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (waiting.onAbort && waiting.signal) waiting.signal.removeEventListener('abort', waiting.onAbort);
        if (message.error) {
          if (waiting.method === 'turn/start') this.allowedTurns.delete(waiting.threadId);
          waiting.reject(new Error(`Codex ${waiting.method}: ${message.error.message}`));
        }
        else waiting.resolve(message.result);
      } else if (message.method) {
        if (message.method === 'turn/started' && this.enforceAllowedTurns) {
          // One explicit request permits one turn, not automatic continuation.
          if (!this.allowedTurns.delete(message.params?.threadId)) {
            const error = new Error('Codex probe attempted an unrequested turn; no sample accepted');
            error.code = 'MODELTRACE_UNREQUESTED_TURN';
            fail(error); return;
          }
        }
        // A probe is text-only. Never approve a server-initiated tool/permission request.
        if (message.id !== undefined) this.write({ id: message.id, error: { code: -32601, message: 'ModelTrace probes do not execute tools or grant permissions' } });
        for (const listener of this.listeners) listener(message);
      }
    }, fail, protocolOptions);
    child.stderr.resume();
    child.stdin.on('error', (error) => { if (!this.closing) fail(error); });
  }
  write(message) { if (this.failure) throw this.failure; if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, timeout = 15000, options = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('Codex probe transport is closed'));
    if (options?.signal?.aborted) return Promise.reject(new Error(`Codex ${method} aborted`));
    if (method === 'turn/start') this.allowedTurns.add(params.threadId);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      let onAbort;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (options?.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
        if (method === 'turn/start') this.allowedTurns.delete(params.threadId);
        reject(new Error(`Codex ${method} timed out`));
      }, timeout);
      if (options?.signal) {
        onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          if (method === 'turn/start') this.allowedTurns.delete(params.threadId);
          reject(new Error(`Codex ${method} aborted`));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, { resolve, reject, timer, method, threadId: params.threadId, onAbort, signal: options?.signal });
      try { this.write({ id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        if (options?.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
        if (method === 'turn/start') this.allowedTurns.delete(params.threadId);
        reject(error);
      }
    });
  }
  async close(timeoutMs) {
    if (this.closed) return;
    if (this.closing) return this.exited;
    this.closing = true;
    try { this.child.stdin.end(); } catch {}
    let timer;
    const gracefulMs = timeoutMs !== undefined
      ? Math.min(2000, Math.max(10, Math.floor(timeoutMs * 0.4)))
      : 2000;
    const exitMs = timeoutMs !== undefined
      ? Math.min(3000, Math.max(10, timeoutMs - gracefulMs))
      : 3000;
    await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, gracefulMs); })]);
    clearTimeout(timer);
    if (!this.closed) {
      try { this.child.kill('SIGTERM'); } catch {}
    }
    await Promise.race([this.exited, new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { this.child.kill('SIGKILL'); } catch {}
        reject(new Error('Could not confirm temporary Codex process cleanup'));
      }, exitMs);
    })]).finally(() => clearTimeout(timer));
    this.lines?.close();
  }
}

export async function openAppServer(env = process.env, protocolOptions = {}) {
  if (protocolOptions.signal?.aborted) {
    throw new Error('App-server initialization aborted');
  }
  const deadline = protocolOptions.deadline;
  if (deadline && Date.now() >= deadline) {
    throw new Error('App-server initialization timed out (deadline exceeded)');
  }
  const executable = await codexExecutable(env);
  if (protocolOptions.signal?.aborted) {
    throw new Error('App-server initialization aborted');
  }
  if (deadline && Date.now() >= deadline) {
    throw new Error('App-server initialization timed out (deadline exceeded)');
  }
  const child = spawn(executable, ['app-server', '--stdio'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, MODELTRACE_PROBE_PROCESS: '1' },
  });
  const client = new AppServerClient(child, protocolOptions);
  if (typeof protocolOptions.onClient === 'function') {
    try { protocolOptions.onClient(client); } catch {}
  }
  const rem = deadline ? deadline - Date.now() : 15000;
  const initTimeout = protocolOptions.timeout !== undefined ? Math.min(protocolOptions.timeout, rem) : rem;
  if (initTimeout <= 0) {
    client.destroy(new Error('App-server initialization timed out (deadline exceeded)'));
    try { await client.close(50); } catch {}
    throw new Error('App-server initialization timed out (deadline exceeded)');
  }
  let onAbort;
  if (protocolOptions.signal) {
    if (protocolOptions.signal.aborted) {
      client.destroy(new Error('App-server initialization aborted'));
      try { await client.close(50); } catch {}
      throw new Error('App-server initialization aborted');
    }
    onAbort = () => {
      client.destroy(new Error('App-server initialization aborted'));
    };
    protocolOptions.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    await client.request(
      'initialize',
      { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: true } },
      initTimeout,
      { signal: protocolOptions.signal }
    );
    client.write({ method: 'initialized' });
    return client;
  } catch (error) {
    client.destroy(error);
    const remClose = deadline ? Math.max(20, Math.min(200, deadline - Date.now() - 20)) : 100;
    await client.close(remClose).catch(() => {});
    throw error;
  } finally {
    if (protocolOptions.signal && onAbort) {
      protocolOptions.signal.removeEventListener('abort', onAbort);
    }
  }
}

const CODEX_UUID_REGEX = /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTimeout(promiseOrFn, ms, opName = 'Operation') {
  if (ms <= 0) {
    throw new Error(`${opName} timed out (deadline exceeded)`);
  }
  let timer;
  try {
    const promise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${opName} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function pauseThreadGoal(session, env = process.env, dependencies = {}) {
  const isCustomConnect = Boolean(dependencies.client || dependencies.connect);
  if (!isCustomConnect && !CODEX_UUID_REGEX.test(session)) {
    return { hasGoal: false, paused: true, previousStatus: null, goal: null };
  }
  const hookTimeoutMs = dependencies.hookTimeoutMs ?? dependencies.deadlineMs ?? dependencies.timeoutMs ?? Number(env?.MODELTRACE_HOOK_DEADLINE_MS || 4000);
  const deadline = dependencies.deadline ?? (Date.now() + hookTimeoutMs);
  const connect = dependencies.connect || ((e, opts) => openAppServer(e, { enforceAllowedTurns: false, ...opts }));

  let client;
  let spawnedClient = null;
  let connectTimedOut = false;
  const abortController = new AbortController();

  if (dependencies.client) {
    client = dependencies.client;
  } else {
    const remConnect = deadline - Date.now();
    if (remConnect <= 0) {
      throw new Error('App-server initialization timed out (deadline exceeded)');
    }
    const reserveAfterConnect = Math.min(300, Math.max(60, Math.floor(remConnect * 0.3)));
    const connectBudget = remConnect - reserveAfterConnect;
    const connectOpts = {
      deadline,
      timeout: connectBudget,
      signal: abortController.signal,
      onClient: (c) => { spawnedClient = c; },
    };
    const connectPromise = Promise.resolve().then(() => connect(env, connectOpts));
    connectPromise.then(
      (c) => {
        if (connectTimedOut && c) {
          try { c.destroy?.(); } catch {}
          try { c.child?.kill?.('SIGKILL'); } catch {}
          try { c.close?.(100).catch(() => {}); } catch {}
        }
      },
      () => {}
    );
    try {
      client = await withTimeout(() => connectPromise, connectBudget, 'App-server initialization');
    } catch (err) {
      connectTimedOut = true;
      abortController.abort();
      if (spawnedClient) {
        try { spawnedClient.destroy?.(err); } catch {}
        try { spawnedClient.child?.kill?.('SIGKILL'); } catch {}
        const remClose = Math.max(20, Math.min(200, deadline - Date.now() - 20));
        try {
          await withTimeout(() => spawnedClient.close(remClose), remClose, 'App-server client cleanup');
        } catch {
          try { spawnedClient.child?.kill?.('SIGKILL'); } catch {}
        }
      }
      throw err;
    }
  }

  try {
    const remGet = deadline - Date.now();
    if (remGet <= 0) {
      throw new Error('Codex thread/goal/get timed out (deadline exceeded)');
    }
    const reserveAfterGet = Math.min(200, Math.max(40, Math.floor(remGet * 0.3)));
    const getBudget = remGet - reserveAfterGet;
    const getRes = await withTimeout(
      () => client.request('thread/goal/get', { threadId: session }, getBudget, { signal: abortController.signal }),
      getBudget,
      'Codex thread/goal/get'
    );
    const currentGoal = getRes?.goal;
    if (!currentGoal || currentGoal.status === 'paused' || currentGoal.status === 'complete' || currentGoal.status === 'abandoned') {
      return { hasGoal: Boolean(currentGoal), paused: true, previousStatus: currentGoal?.status || null, goal: currentGoal || null };
    }

    const remSet = deadline - Date.now();
    if (remSet <= 0) {
      throw new Error('Codex thread/goal/set timed out (deadline exceeded)');
    }
    const reserveAfterSet = Math.min(100, Math.max(20, Math.floor(remSet * 0.3)));
    const setBudget = remSet - reserveAfterSet;
    const setRes = await withTimeout(
      () => client.request('thread/goal/set', { threadId: session, status: 'paused' }, setBudget, { signal: abortController.signal }),
      setBudget,
      'Codex thread/goal/set'
    );
    if (setRes?.goal?.status !== 'paused') {
      throw new Error(`Host goal pause unconfirmed: status is ${setRes?.goal?.status || 'unknown'}`);
    }
    return { hasGoal: true, paused: true, previousStatus: currentGoal.status, goal: setRes.goal };
  } catch (err) {
    abortController.abort();
    throw err;
  } finally {
    if (!dependencies.client && client) {
      const remClose = deadline - Date.now() - 20;
      const closeBudget = Math.max(20, Math.min(200, remClose));
      try {
        if (remClose <= 0) {
          try { client.destroy?.(); } catch {}
          try { client.child?.kill?.('SIGKILL'); } catch {}
          client.close?.(50).catch(() => {});
        } else {
          await withTimeout(() => client.close(closeBudget), closeBudget, 'App-server client cleanup');
        }
      } catch {
        try { client.destroy?.(); } catch {}
        try { client.child?.kill?.('SIGKILL'); } catch {}
      }
    }
  }
}

export async function resumeThreadGoal(session, env = process.env, dependencies = {}) {
  const isCustomConnect = Boolean(dependencies.client || dependencies.connect);
  if (!isCustomConnect && !CODEX_UUID_REGEX.test(session)) {
    return { hasGoal: false, resumed: false, goal: null };
  }
  const hookTimeoutMs = dependencies.hookTimeoutMs ?? dependencies.deadlineMs ?? dependencies.timeoutMs ?? Number(env?.MODELTRACE_HOOK_DEADLINE_MS || 4000);
  const deadline = dependencies.deadline ?? (Date.now() + hookTimeoutMs);
  const connect = dependencies.connect || ((e, opts) => openAppServer(e, { enforceAllowedTurns: false, ...opts }));

  let client;
  let spawnedClient = null;
  let connectTimedOut = false;
  const abortController = new AbortController();

  if (dependencies.client) {
    client = dependencies.client;
  } else {
    const remConnect = deadline - Date.now();
    if (remConnect <= 0) {
      throw new Error('App-server initialization timed out (deadline exceeded)');
    }
    const reserveAfterConnect = Math.min(300, Math.max(60, Math.floor(remConnect * 0.3)));
    const connectBudget = remConnect - reserveAfterConnect;
    const connectOpts = {
      deadline,
      timeout: connectBudget,
      signal: abortController.signal,
      onClient: (c) => { spawnedClient = c; },
    };
    const connectPromise = Promise.resolve().then(() => connect(env, connectOpts));
    connectPromise.then(
      (c) => {
        if (connectTimedOut && c) {
          try { c.destroy?.(); } catch {}
          try { c.child?.kill?.('SIGKILL'); } catch {}
          try { c.close?.(100).catch(() => {}); } catch {}
        }
      },
      () => {}
    );
    try {
      client = await withTimeout(() => connectPromise, connectBudget, 'App-server initialization');
    } catch (err) {
      connectTimedOut = true;
      abortController.abort();
      if (spawnedClient) {
        try { spawnedClient.destroy?.(err); } catch {}
        try { spawnedClient.child?.kill?.('SIGKILL'); } catch {}
        const remClose = Math.max(20, Math.min(200, deadline - Date.now() - 20));
        try {
          await withTimeout(() => spawnedClient.close(remClose), remClose, 'App-server client cleanup');
        } catch {
          try { spawnedClient.child?.kill?.('SIGKILL'); } catch {}
        }
      }
      throw err;
    }
  }

  try {
    const remGet = deadline - Date.now();
    if (remGet <= 0) {
      throw new Error('Codex thread/goal/get timed out (deadline exceeded)');
    }
    const reserveAfterGet = Math.min(200, Math.max(40, Math.floor(remGet * 0.3)));
    const getBudget = remGet - reserveAfterGet;
    const getRes = await withTimeout(
      () => client.request('thread/goal/get', { threadId: session }, getBudget, { signal: abortController.signal }),
      getBudget,
      'Codex thread/goal/get'
    );
    const currentGoal = getRes?.goal;
    if (!currentGoal) return { hasGoal: false, resumed: false, goal: null };
    if (currentGoal.status === 'active') return { hasGoal: true, resumed: true, goal: currentGoal };
    if (currentGoal.status === 'complete' || currentGoal.status === 'abandoned') {
      return { hasGoal: true, resumed: false, goal: currentGoal, reason: `Goal is already ${currentGoal.status}` };
    }

    const remSet = deadline - Date.now();
    if (remSet <= 0) {
      throw new Error('Codex thread/goal/set timed out (deadline exceeded)');
    }
    const reserveAfterSet = Math.min(100, Math.max(20, Math.floor(remSet * 0.3)));
    const setBudget = remSet - reserveAfterSet;
    const setRes = await withTimeout(
      () => client.request('thread/goal/set', { threadId: session, status: 'active' }, setBudget, { signal: abortController.signal }),
      setBudget,
      'Codex thread/goal/set'
    );
    if (setRes?.goal?.status !== 'active') {
      throw new Error(`Host goal resume unconfirmed: status is ${setRes?.goal?.status || 'unknown'}`);
    }
    return { hasGoal: true, resumed: true, goal: setRes.goal };
  } catch (err) {
    abortController.abort();
    throw err;
  } finally {
    if (!dependencies.client && client) {
      const remClose = deadline - Date.now() - 20;
      const closeBudget = Math.max(20, Math.min(200, remClose));
      try {
        if (remClose <= 0) {
          try { client.destroy?.(); } catch {}
          try { client.child?.kill?.('SIGKILL'); } catch {}
          client.close?.(50).catch(() => {});
        } else {
          await withTimeout(() => client.close(closeBudget), closeBudget, 'App-server client cleanup');
        }
      } catch {
        try { client.destroy?.(); } catch {}
        try { client.child?.kill?.('SIGKILL'); } catch {}
      }
    }
  }
}

