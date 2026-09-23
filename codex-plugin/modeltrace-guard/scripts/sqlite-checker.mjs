import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function getDefaultDbPath(env = process.env) {
  if (env.CODEX_LOGS_DB) return path.resolve(env.CODEX_LOGS_DB);
  return path.join(os.homedir(), '.codex', 'logs_2.sqlite');
}

export function extractHeadersJson(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\bheaders\s*[:=]\s*\{/);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const raw = text.slice(start, i + 1);
          try { return JSON.parse(raw); } catch { return null; }
        }
      }
    }
  }
  return null;
}

export function parseLogBody(body) {
  if (typeof body !== 'string') return {};
  const rawModel = body.match(/\bmodel=(?:"([^"]+)"|'([^']+)'|([^\s,}]+))/);
  const model = (rawModel?.[1] || rawModel?.[2] || rawModel?.[3] || '').replace(/^["']|["']$/g, '') || null;

  const rawTurnId = body.match(/\bturn(?:_|\.)id=(?:"([^"]+)"|'([^']+)'|([^\s,}]+))/);
  const turnId = (rawTurnId?.[1] || rawTurnId?.[2] || rawTurnId?.[3] || '').replace(/^["']|["']$/g, '') || null;

  const rawThreadId = body.match(/\bthread(?:_|\.)id=(?:"([^"]+)"|'([^']+)'|([^\s,}]+))/);
  const threadId = (rawThreadId?.[1] || rawThreadId?.[2] || rawThreadId?.[3] || '').replace(/^["']|["']$/g, '') || null;

  const status = body.match(/\bstatus=(\d+)/)?.[1] ? Number(body.match(/\bstatus=(\d+)/)[1]) : null;
  const method = body.match(/\bmethod=([A-Z]+)/)?.[1] || null;
  const rawHeaders = extractHeadersJson(body) || {};

  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers[key.toLowerCase()] = value;
  }

  // Fallback regex matching in case JSON was truncated or malformed
  const safetyBufferingEnabled = headers['x-codex-safety-buffering-enabled'] !== undefined
    ? (headers['x-codex-safety-buffering-enabled'] === 'true' || headers['x-codex-safety-buffering-enabled'] === true)
    : /"x-codex-safety-buffering-enabled":\s*(?:"true"|true)/i.test(body);

  const fasterModel = headers['x-codex-safety-buffering-faster-model']
    || body.match(/"x-codex-safety-buffering-faster-model":\s*"([^"]+)"/)?.[1]
    || null;

  const rawUsedPercent = headers['x-codex-primary-used-percent']
    || body.match(/"x-codex-primary-used-percent":\s*(?:"([^"]+)"|(\d+))/)?.[1]
    || body.match(/"x-codex-primary-used-percent":\s*(?:"([^"]+)"|(\d+))/)?.[2];
  const primaryUsedPercent = rawUsedPercent !== undefined && rawUsedPercent !== null && !isNaN(Number(rawUsedPercent))
    ? Number(rawUsedPercent)
    : null;

  const activeLimit = headers['x-codex-active-limit']
    || body.match(/"x-codex-active-limit":\s*"([^"]+)"/)?.[1]
    || null;

  const planType = headers['x-codex-plan-type']
    || body.match(/"x-codex-plan-type":\s*"([^"]+)"/)?.[1]
    || null;

  return {
    model,
    turnId,
    threadId,
    status,
    method,
    headers,
    safetyBufferingEnabled,
    fasterModel,
    primaryUsedPercent,
    activeLimit,
    planType,
  };
}

export function analyzeRecord(record, { expectedModel } = {}) {
  if (!record || typeof record.feedback_log_body !== 'string') return null;
  const parsed = parseLogBody(record.feedback_log_body);
  const requestedModel = parsed.model;
  const expected = expectedModel || requestedModel;
  const fasterModel = parsed.fasterModel;
  const safetyBufferingEnabled = parsed.safetyBufferingEnabled;
  const primaryUsedPercent = parsed.primaryUsedPercent;

  let degraded = false;
  let reason = null;

  if (safetyBufferingEnabled) {
    degraded = true;
    if (fasterModel && expected && fasterModel !== expected) {
      reason = `服务端启用 Safety Buffering 降级（实际模型: ${fasterModel}，低于预期: ${expected}）`;
    } else if (fasterModel) {
      reason = `服务端启用 Safety Buffering 降级（降级模型: ${fasterModel}）`;
    } else {
      reason = '服务端启用 Safety Buffering 降级通道';
    }
  } else if (fasterModel) {
    if (expected && fasterModel !== expected) {
      degraded = true;
      reason = `服务端返回备用模型（实际模型: ${fasterModel}，低于预期: ${expected}）`;
    } else if (!expected) {
      degraded = true;
      reason = `服务端返回备用模型（降级模型: ${fasterModel}）`;
    }
  } else if (expected && requestedModel && expected !== requestedModel) {
    degraded = true;
    reason = `请求模型 (${requestedModel}) 与预期模型 (${expected}) 不一致`;
  }

  return {
    logId: record.id,
    ts: record.ts,
    requestedModel,
    expectedModel: expected,
    fasterModel,
    safetyBufferingEnabled,
    primaryUsedPercent,
    activeLimit: parsed.activeLimit,
    planType: parsed.planType,
    turnId: parsed.turnId,
    threadId: parsed.threadId,
    status: parsed.status,
    degraded,
    reason,
    headers: parsed.headers,
  };
}

export async function runQueryWithCli(dbPath, sql, { timeout = 2000 } = {}) {
  const resolved = path.resolve(dbPath);
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-cmd', '.timeout 2000', '-json', `file:${resolved}?mode=ro`, sql], { timeout, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(error);
      const trimmed = (stdout || '').trim();
      if (!trimmed) return resolve([]);
      try {
        resolve(JSON.parse(trimmed));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function runQueryWithNodeSqlite(dbPath, sql) {
  const { DatabaseSync } = await import('node:sqlite');
  const resolved = path.resolve(dbPath);
  const db = new DatabaseSync(resolved, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000;');
    const rows = db.prepare(sql).all();
    return rows || [];
  } finally {
    db.close();
  }
}

export async function runQuery(dbPath, sql, options = {}) {
  if (typeof options.execFn === 'function') return options.execFn(dbPath, sql, options);
  try {
    return await runQueryWithCli(dbPath, sql, options);
  } catch (cliErr) {
    try {
      return await runQueryWithNodeSqlite(dbPath, sql);
    } catch {
      throw cliErr;
    }
  }
}

export async function queryLatestRecord({ dbPath, sessionId, limit = 500, env = process.env, execFn, allowGlobalFallback = false } = {}) {
  const targetDb = path.resolve(dbPath || getDefaultDbPath(env));
  if (!existsSync(targetDb)) return null;

  if (sessionId) {
    const escapedSessionId = String(sessionId).replace(/'/g, "''");
    const sql = `SELECT id, ts, feedback_log_body FROM logs WHERE thread_id = '${escapedSessionId}' AND target = 'codex_http_client::client' AND feedback_log_body LIKE '%/responses%' ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 1;`;
    const rows = await runQuery(targetDb, sql, { execFn });
    if (Array.isArray(rows) && rows.length > 0) return rows[0];
    if (!allowGlobalFallback) return null;
  }

  const sql = `SELECT id, ts, feedback_log_body FROM logs WHERE target = 'codex_http_client::client' AND feedback_log_body LIKE '%/responses%' ORDER BY id DESC LIMIT 1;`;
  const rows = await runQuery(targetDb, sql, { execFn });
  if (Array.isArray(rows) && rows.length > 0) return rows[0];
  return null;
}

export async function checkSqliteLatest({ dbPath, sessionId, expectedModel, lastLogId = null, env = process.env, execFn, allowGlobalFallback = false } = {}) {
  try {
    const targetDb = path.resolve(dbPath || getDefaultDbPath(env));
    if (!existsSync(targetDb)) return { checked: false, reason: 'database_not_found', degraded: false };
    const row = await queryLatestRecord({ dbPath: targetDb, sessionId, env, execFn, allowGlobalFallback });
    if (!row) return { checked: true, record: null, degraded: false };
    if (lastLogId !== null && lastLogId !== undefined && row.id <= lastLogId) {
      return { checked: true, record: null, alreadySeen: true, degraded: false };
    }
    const analysis = analyzeRecord(row, { expectedModel });
    return {
      checked: true,
      degraded: Boolean(analysis?.degraded),
      reason: analysis?.reason || null,
      record: analysis,
    };
  } catch (error) {
    return { checked: false, error: error.message, degraded: false };
  }
}

const isDirectCall = (entryUrl) => {
  if (!process.argv[1]) return false;
  const target = fileURLToPath(entryUrl);
  if (path.resolve(process.argv[1]) === target) return true;
  try { return existsSync(process.argv[1]) && realpathSync(process.argv[1]) === target; } catch { return false; }
};

if (isDirectCall(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i].replace(/^--/, '');
    options[k] = args[i + 1];
  }
  const result = await checkSqliteLatest({
    dbPath: options.db,
    sessionId: options.session,
    expectedModel: options.expected,
    allowGlobalFallback: !options.session,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
