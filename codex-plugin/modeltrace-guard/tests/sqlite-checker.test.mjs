import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  parseLogBody,
  analyzeRecord,
  extractHeadersJson,
  checkSqliteLatest,
  queryLatestRecord,
  getDefaultDbPath,
} from '../scripts/sqlite-checker.mjs';
import { queueTelemetryAlert, userNotice, pendingAlerts, acknowledgeAlerts } from '../scripts/alerts.mjs';
import { handleHook, ROOT, isControlCommand, run } from '../scripts/guard.mjs';
import { handleBackgroundHook } from '../scripts/background.mjs';
import { newState, withState, readState } from '../scripts/state.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'modeltrace-sqlite-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function initTestDb(dbFile) {
  const sql = `
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL DEFAULT 0,
      level TEXT NOT NULL DEFAULT 'DEBUG',
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      thread_id TEXT
    );
    CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
    CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
  `;
  execFileSync('sqlite3', [dbFile, sql]);
}

function insertTestLog(dbFile, { id, ts, threadId, target = 'codex_http_client::client', body }) {
  const insertSql = id
    ? `INSERT INTO logs (id, ts, ts_nanos, target, feedback_log_body, thread_id) VALUES (${id}, ${ts}, 0, '${target}', '${body.replace(/'/g, "''")}', '${threadId}');`
    : `INSERT INTO logs (ts, ts_nanos, target, feedback_log_body, thread_id) VALUES (${ts}, 0, '${target}', '${body.replace(/'/g, "''")}', '${threadId}');`;
  execFileSync('sqlite3', [dbFile, insertSql]);
}

test('extractHeadersJson correctly parses JSON objects with nested braces and escaped quotes', () => {
  const sample = 'Request completed headers={"date": "Thu, 17 Sep 2026", "x-models-etag": "W/\\"82b75e\\"", "nested": {"key": "val"}} version=HTTP/1.1';
  const headers = extractHeadersJson(sample);
  assert.equal(headers.date, 'Thu, 17 Sep 2026');
  assert.equal(headers['x-models-etag'], 'W/"82b75e"');
  assert.deepEqual(headers.nested, { key: 'val' });

  // Colon and space format
  const colonSample = 'connected to websocket, headers: {"date": "Wed, 23 Sep 2026", "connection": "upgrade"}';
  const colonHeaders = extractHeadersJson(colonSample);
  assert.equal(colonHeaders.date, 'Wed, 23 Sep 2026');
  assert.equal(colonHeaders.connection, 'upgrade');

  assert.equal(extractHeadersJson('no headers here'), null);
  assert.equal(extractHeadersJson(null), null);
});

test('parseLogBody accurately extracts telemetry parameters from codex log text', () => {
  const body = 'session_loop{thread_id=session-abc}:turn{thread.id=session-abc turn.id=turn-123 model=gpt-6-astra codex.turn.reasoning_effort=low}:stream_request:model_client.stream_responses_api{model=gpt-6-astra api.path="/responses"}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 OK headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "85", "x-codex-active-limit": "premium", "x-codex-plan-type": "pro"} version=HTTP/1.1';

  const parsed = parseLogBody(body);
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.turnId, 'turn-123');
  assert.equal(parsed.threadId, 'session-abc');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.safetyBufferingEnabled, true);
  assert.equal(parsed.fasterModel, 'gpt-5.6-luna');
  assert.equal(parsed.primaryUsedPercent, 85);
  assert.equal(parsed.activeLimit, 'premium');
  assert.equal(parsed.planType, 'pro');
});

test('parseLogBody strips quotes from model, turn.id and thread.id to prevent false-positive mismatch', () => {
  const quoted = 'turn{thread.id="sess-1" turn.id="turn-2" model="gpt-6-astra"}: Request completed status=200';
  const parsed = parseLogBody(quoted);
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.turnId, 'turn-2');
  assert.equal(parsed.threadId, 'sess-1');

  const analysis = analyzeRecord({ feedback_log_body: quoted }, { expectedModel: 'gpt-6-astra' });
  assert.equal(analysis.degraded, false);
});

test('parseLogBody falls back to regex when JSON is incomplete or malformed', () => {
  const malformed = 'turn{model=gpt-5.4}: Request completed headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "42" (incomplete string';
  const parsed = parseLogBody(malformed);
  assert.equal(parsed.model, 'gpt-5.4');
  assert.equal(parsed.safetyBufferingEnabled, true);
  assert.equal(parsed.fasterModel, 'gpt-5.6-luna');
  assert.equal(parsed.primaryUsedPercent, 42);

  const unquoted = 'turn{model=gpt-5.4}: Request completed headers={"x-codex-safety-buffering-enabled": true, "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": 42 (incomplete string';
  const parsedUnquoted = parseLogBody(unquoted);
  assert.equal(parsedUnquoted.safetyBufferingEnabled, true);
  assert.equal(parsedUnquoted.primaryUsedPercent, 42);
});

test('analyzeRecord detects degradation and creates proper reason strings', () => {
  const normalRecord = {
    id: 100,
    ts: 1789642000,
    feedback_log_body: 'turn{model=gpt-6-astra}: Request completed status=200 headers={"x-codex-primary-used-percent": "20"}',
  };
  const normalAnalysis = analyzeRecord(normalRecord, { expectedModel: 'gpt-6-astra' });
  assert.equal(normalAnalysis.degraded, false);
  assert.equal(normalAnalysis.reason, null);
  assert.equal(normalAnalysis.requestedModel, 'gpt-6-astra');

  const degradedRecord = {
    id: 101,
    ts: 1789642100,
    feedback_log_body: 'turn{model=gpt-6-astra}: Request completed status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "90"}',
  };
  const degradedAnalysis = analyzeRecord(degradedRecord, { expectedModel: 'gpt-6-astra' });
  assert.equal(degradedAnalysis.degraded, true);
  assert.ok(degradedAnalysis.reason.includes('Safety Buffering'));
  assert.ok(degradedAnalysis.reason.includes('gpt-5.6-luna'));
  assert.equal(degradedAnalysis.primaryUsedPercent, 90);

  // Faster model without expected model specified
  const noExpectedRecord = {
    id: 1011,
    ts: 1789642150,
    feedback_log_body: 'turn{}: Request completed status=200 headers={"x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  };
  const noExpectedAnalysis = analyzeRecord(noExpectedRecord);
  assert.equal(noExpectedAnalysis.degraded, true);
  assert.ok(noExpectedAnalysis.reason.includes('gpt-5.6-luna'));

  const modelMismatchRecord = {
    id: 102,
    ts: 1789642200,
    feedback_log_body: 'turn{model=gpt-5.4}: Request completed status=200 headers={}',
  };
  const mismatchAnalysis = analyzeRecord(modelMismatchRecord, { expectedModel: 'gpt-6-astra' });
  assert.equal(mismatchAnalysis.degraded, true);
  assert.ok(mismatchAnalysis.reason.includes('不一致'));
});

test('queueTelemetryAlert and userNotice handle telemetry alerts correctly', () => {
  const state = newState('session-1');
  state.expected = 'gpt-6-astra';
  const telemetry = {
    logId: 1001,
    requestedModel: 'gpt-6-astra',
    fasterModel: 'gpt-5.6-luna',
    primaryUsedPercent: 95,
    reason: '服务端启用 Safety Buffering 降级（实际模型: gpt-5.6-luna，低于预期: gpt-6-astra）',
  };

  const alert = queueTelemetryAlert(state, telemetry, 1000);
  assert.equal(alert.id, 'telemetry-1001');
  assert.equal(alert.level, 'telemetry_downgrade');
  assert.equal(alert.expected, 'gpt-6-astra');
  assert.equal(alert.prediction, 'gpt-5.6-luna');
  assert.equal(pendingAlerts(state).length, 1);

  // Deduplication
  const duplicate = queueTelemetryAlert(state, telemetry, 1005);
  assert.equal(duplicate.id, alert.id);
  assert.equal(state.alerts.length, 1);

  const notice = userNotice(alert);
  assert.ok(notice.includes('本地 SQLite 遥测发现服务端降级指令'));
  assert.ok(notice.includes('gpt-5.6-luna'));
  assert.ok(notice.includes('95%'));
  assert.ok(notice.includes('fast-fail 阻断'));

  // Acknowledging clears pending
  acknowledgeAlerts(state, [alert.id], 1010);
  assert.equal(pendingAlerts(state).length, 0);
});

test('checkSqliteLatest with SQLite database fixture isolates sessions and respects lastLogId', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'test_logs.sqlite');
  initTestDb(dbFile);

  // Missing database check
  const missingResult = await checkSqliteLatest({ dbPath: path.join(dir, 'missing.sqlite') });
  assert.equal(missingResult.checked, false);
  assert.equal(missingResult.reason, 'database_not_found');

  // Insert session A (normal) and session B (degraded)
  insertTestLog(dbFile, {
    id: 1,
    ts: 1789642000,
    threadId: 'session-A',
    body: 'turn{thread.id=session-A model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-primary-used-percent": "10"}',
  });
  insertTestLog(dbFile, {
    id: 2,
    ts: 1789642010,
    threadId: 'session-B',
    body: 'turn{thread.id=session-B model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "92"}',
  });

  // Query session A: not degraded
  const resultA = await checkSqliteLatest({
    dbPath: dbFile,
    sessionId: 'session-A',
    expectedModel: 'gpt-6-astra',
  });
  assert.equal(resultA.checked, true);
  assert.equal(resultA.degraded, false);
  assert.equal(resultA.record.logId, 1);

  // Query session B: degraded
  const resultB = await checkSqliteLatest({
    dbPath: dbFile,
    sessionId: 'session-B',
    expectedModel: 'gpt-6-astra',
  });
  assert.equal(resultB.checked, true);
  assert.equal(resultB.degraded, true);
  assert.equal(resultB.record.logId, 2);
  assert.equal(resultB.record.fasterModel, 'gpt-5.6-luna');

  // Deduplication with lastLogId
  const resultBRepeat = await checkSqliteLatest({
    dbPath: dbFile,
    sessionId: 'session-B',
    expectedModel: 'gpt-6-astra',
    lastLogId: 2,
  });
  assert.equal(resultBRepeat.checked, true);
  assert.equal(resultBRepeat.alreadySeen, true);
  assert.equal(resultBRepeat.degraded, false);

  // Non-matching session returns null record
  const resultC = await checkSqliteLatest({
    dbPath: dbFile,
    sessionId: 'session-unknown',
    expectedModel: 'gpt-6-astra',
  });
  assert.equal(resultC.checked, true);
  assert.equal(resultC.record, null);
  assert.equal(resultC.degraded, false);
});

test('handleHook fast-fails on PreToolUse when SQLite records server-side degradation', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const dbFile = path.join(dir, 'logs_2.sqlite');
  initTestDb(dbFile);

  const sessionId = 'session-fast-fail';
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => { delete process.env.CODEX_LOGS_DB; });

  // Setup active monitoring state
  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
  });

  // Step 1: PreToolUse before any logs -> normal allow
  const initialPreTool = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    dataDir,
    1000
  );
  assert.deepEqual(initialPreTool, {});

  // Step 2: Insert degraded log into SQLite
  insertTestLog(dbFile, {
    id: 50,
    ts: 1789643000,
    threadId: sessionId,
    body: 'turn{thread.id=session-fast-fail model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "88"}',
  });

  // Tool hooks (PreToolUse / PostToolUse) do NOT poll SQLite
  const unpolledPreTool = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    dataDir,
    1001
  );
  assert.deepEqual(unpolledPreTool, {});
  const unpolledPostTool = await handleHook(
    { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    dataDir,
    1002
  );
  assert.deepEqual(unpolledPostTool, {});
  const unpolledBgPostTool = await handleBackgroundHook(
    { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    dataDir
  );
  assert.deepEqual(unpolledBgPostTool, {});
  const stateBeforeChat = await readState(dataDir, sessionId);
  assert.equal(stateBeforeChat.lastSqliteLogId, undefined);
  assert.equal(pendingAlerts(stateBeforeChat).length, 0);

  // Step 3: Chat event (UserPromptSubmit via handleBackgroundHook as in hooks.json) checks SQLite and triggers alert
  const chatHook = await handleBackgroundHook(
    { session_id: sessionId, hook_event_name: 'UserPromptSubmit' },
    dataDir
  );
  assert.ok(chatHook.systemMessage?.includes('本地 SQLite 遥测发现服务端降级指令'));

  // Step 4: Next PreToolUse must FAST-FAIL and deny the tool due to pending alert
  const blockedPreTool = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    dataDir,
    1004
  );
  assert.equal(blockedPreTool.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(blockedPreTool.hookSpecificOutput?.permissionDecisionReason.includes('gpt-5.6-luna'));
  assert.ok(blockedPreTool.systemMessage.includes('本地 SQLite 遥测发现服务端降级指令'));

  // Step 5: Verify state was updated with lastSqliteLogId and alert
  const stateAfterBlock = await readState(dataDir, sessionId);
  assert.equal(stateAfterBlock.lastSqliteLogId, 50);
  assert.equal(stateAfterBlock.alerts.length, 1);
  assert.equal(pendingAlerts(stateAfterBlock).length, 1);

  // Step 6: Stop hook also blocks turn while alert is pending
  const stopResult = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop' },
    dataDir,
    1005
  );
  assert.equal(stopResult.decision, 'block');

  // Step 7: Control commands like `guard.mjs status` are permitted even during deny
  assert.equal(isControlCommand({ tool_name: 'Bash', tool_input: { command: 'node guard.mjs status' } }), false); // Not ROOT path
  assert.equal(isControlCommand({ tool_name: 'Bash', tool_input: { command: `node "${path.join(ROOT, 'scripts', 'guard.mjs')}" check-sqlite` } }), true);

  // Step 8: Acknowledge the alert
  await withState(dataDir, sessionId, (s) => {
    acknowledgeAlerts(s, [stateAfterBlock.alerts[0].id], 1006);
  });

  // Step 9: Subsequent PreToolUse with same log ID is allowed (not re-alerted)
  const afterAckPreTool = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    dataDir,
    1007
  );
  assert.deepEqual(afterAckPreTool, {});

  // Step 10: Stop hook checks SQLite directly if new degradation occurs
  insertTestLog(dbFile, {
    id: 51,
    ts: 1789643100,
    threadId: sessionId,
    body: 'turn{thread.id=session-fast-fail model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "90"}',
  });
  const stopWithNewDegradation = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-2' },
    dataDir,
    1008
  );
  assert.equal(stopWithNewDegradation.decision, 'block');
  assert.ok(stopWithNewDegradation.systemMessage?.includes('服务端降级指令'));
  const stateAfterStop = await readState(dataDir, sessionId);
  assert.equal(stateAfterStop.lastSqliteLogId, 51);
});

test('guard.mjs check-sqlite CLI command works as expected', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'cli_logs.sqlite');
  initTestDb(dbFile);

  insertTestLog(dbFile, {
    id: 88,
    ts: 1789644000,
    threadId: 'cli-session',
    body: 'turn{thread.id=cli-session model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });

  const res = spawnSync(
    'node',
    [path.join(ROOT, 'scripts', 'guard.mjs'), 'check-sqlite', '--session', 'cli-session'],
    {
      encoding: 'utf8',
      env: { ...process.env, CODEX_LOGS_DB: dbFile },
    }
  );
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.checked, true);
  assert.equal(json.degraded, true);
  assert.equal(json.record.fasterModel, 'gpt-5.6-luna');

  // Verify --db parameter directly
  const resWithDb = spawnSync(
    'node',
    [path.join(ROOT, 'scripts', 'guard.mjs'), 'check-sqlite', '--db', dbFile, '--session', 'cli-session'],
    { encoding: 'utf8' }
  );
  assert.equal(resWithDb.status, 0, resWithDb.stderr);
  const jsonWithDb = JSON.parse(resWithDb.stdout);
  assert.equal(jsonWithDb.checked, true);
  assert.equal(jsonWithDb.degraded, true);
});

test('queueTelemetryAlert does not leak sensitive headers or cookies into state history events', () => {
  const state = newState('session-leak-test');
  const telemetry = {
    logId: 2001,
    requestedModel: 'gpt-6-astra',
    fasterModel: 'gpt-5.6-luna',
    primaryUsedPercent: 90,
    reason: 'Safety buffering',
    headers: {
      'set-cookie': '__oailb=secret_auth_token_12345; Path=/;',
      authorization: 'Bearer secret_api_key',
    },
  };

  queueTelemetryAlert(state, telemetry, 1000);
  const event = state.events.find((e) => e.type === 'telemetry_downgrade_alert');
  assert.ok(event, 'Event should be recorded');
  assert.equal(event.headers, undefined, 'Raw headers must NOT be stored in event history');
  assert.equal(JSON.stringify(event).includes('secret_auth_token'), false);
});

test('strict session isolation: empty session never falls back to another session downgrade', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'isolation_logs.sqlite');
  initTestDb(dbFile);

  insertTestLog(dbFile, {
    id: 1,
    ts: 1789642000,
    threadId: 'degraded-session-x',
    body: 'turn{thread.id=degraded-session-x model=gpt-6-astra}: Request completed status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });

  // Query clean new session with allowGlobalFallback: false
  const cleanResult = await checkSqliteLatest({
    dbPath: dbFile,
    sessionId: 'new-clean-session-y',
    expectedModel: 'gpt-6-astra',
  });
  assert.equal(cleanResult.checked, true);
  assert.equal(cleanResult.record, null);
  assert.equal(cleanResult.degraded, false);
});

test('checkSqliteLatest resolves relative paths correctly', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'rel_logs.sqlite');
  initTestDb(dbFile);

  insertTestLog(dbFile, {
    id: 5,
    ts: 1789642000,
    threadId: 'rel-sess',
    body: 'turn{thread.id=rel-sess model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-primary-used-percent": "50"}',
  });

  const relativePath = path.relative(process.cwd(), dbFile);
  const res = await checkSqliteLatest({
    dbPath: relativePath,
    sessionId: 'rel-sess',
    expectedModel: 'gpt-6-astra',
  });
  assert.equal(res.checked, true);
  assert.equal(res.record?.logId, 5);
  assert.equal(res.degraded, false);
});

test('two consecutive telemetry degradations trigger taskHalt hard stop', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'halt_logs.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-consecutive-halt';
  const originalDb = process.env.CODEX_LOGS_DB;
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => {
    if (originalDb === undefined) delete process.env.CODEX_LOGS_DB;
    else process.env.CODEX_LOGS_DB = originalDb;
  });

  // 初始化会话
  await handleHook({ session_id: sessionId, hook_event_name: 'SessionStart', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1000);

  // 第 1 次降级 (UserPromptSubmit)
  insertTestLog(dbFile, {
    id: 101,
    ts: 1789640001,
    threadId: sessionId,
    body: 'turn{thread.id=session-consecutive-halt model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1001);
  let state = await readState(dataDir, sessionId);
  assert.equal(state.consecutiveDegradedCount, 1);
  assert.equal(state.taskHalt, null);

  // 第 2 次降级 (Stop) -> 立即触发 taskHalt
  insertTestLog(dbFile, {
    id: 102,
    ts: 1789640002,
    threadId: sessionId,
    body: 'turn{thread.id=session-consecutive-halt model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1002);
  state = await readState(dataDir, sessionId);
  assert.equal(state.consecutiveDegradedCount, 2);
  assert.ok(state.taskHalt);
  assert.equal(state.taskHalt.source, 'telemetry');
  assert.equal(state.taskHalt.retryCount, 2);
  assert.equal(state.taskHalt.actual, 'gpt-6-luna');

  assert.equal(state.taskHalt.attempt, 1);
  assert.equal(state.taskHalt.durationMs, 15 * 60 * 1000);
  assert.equal(state.taskHalt.pausedUntil, 1002 + 15 * 60 * 1000);

  // 后续 PreToolUse 在冷却期内必须被拦截 (deny) 并带有倒计时提示
  const preToolResult = await handleHook({ session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-2', model: 'gpt-6.1-sol', tool_name: 'Bash', tool_input: { command: 'ls' } }, dataDir, 1004);
  assert.equal(preToolResult.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(preToolResult.hookSpecificOutput?.permissionDecisionReason?.includes('STOP THE ORIGINAL TASK NOW AND NOTIFY THE USER'));
  assert.ok(preToolResult.hookSpecificOutput?.permissionDecisionReason?.includes('attempt 1/3'));

  // 验证用户 resume 命令能够解除 halt 并重置计数
  const resumeResult = await run(['resume', '--session', sessionId, '--data-dir', dataDir, '--halt', state.taskHalt.id]);
  assert.ok(resumeResult);
  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt, null);
  assert.equal(state.consecutiveDegradedCount, 0);
});

test('exponential backoff canary verification: cooldown expiry permits tool and healthy response recovers session', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'canary_logs.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-canary-recovery';
  const originalDb = process.env.CODEX_LOGS_DB;
  const originalBaseMs = process.env.MODELTRACE_BACKOFF_BASE_MS;
  process.env.CODEX_LOGS_DB = dbFile;
  process.env.MODELTRACE_BACKOFF_BASE_MS = '1000'; // 1s base for test
  t.after(() => {
    if (originalDb === undefined) delete process.env.CODEX_LOGS_DB;
    else process.env.CODEX_LOGS_DB = originalDb;
    if (originalBaseMs === undefined) delete process.env.MODELTRACE_BACKOFF_BASE_MS;
    else process.env.MODELTRACE_BACKOFF_BASE_MS = originalBaseMs;
  });

  await handleHook({ session_id: sessionId, hook_event_name: 'SessionStart', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1000);

  // 两次降级 -> 触发 attempt 1 (1s pause)
  insertTestLog(dbFile, {
    id: 201, ts: 1789640001, threadId: sessionId,
    body: 'turn{thread.id=session-canary-recovery model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1001);

  insertTestLog(dbFile, {
    id: 202, ts: 1789640002, threadId: sessionId,
    body: 'turn{thread.id=session-canary-recovery model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1002);

  let state = await readState(dataDir, sessionId);
  assert.ok(state.taskHalt);
  assert.equal(state.taskHalt.attempt, 1);
  assert.equal(state.taskHalt.durationMs, 1000);
  assert.equal(state.taskHalt.pausedUntil, 2002);

  // 在 1002 ~ 2001 毫秒内，PreToolUse 必须被拦截 (deny)
  const deniedPreTool = await handleHook({ session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-2', model: 'gpt-6.1-sol', tool_name: 'Bash', tool_input: { command: 'ls' } }, dataDir, 1500);
  assert.equal(deniedPreTool.hookSpecificOutput?.permissionDecision, 'deny');

  // 到达 2003 毫秒 (已过 pausedUntil)，PreToolUse 作为金丝雀必须被放行 (允许工具执行)
  const canaryPreTool = await handleHook({ session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-2', model: 'gpt-6.1-sol', tool_name: 'Bash', tool_input: { command: 'ls' } }, dataDir, 2003);
  assert.deepEqual(canaryPreTool, {});
  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt?.canaryActive, true);

  // 随后该金丝雀轮次在 Stop 时发现新日志已恢复正常 (degraded = false)
  insertTestLog(dbFile, {
    id: 203, ts: 1789640003, threadId: sessionId,
    body: 'turn{thread.id=session-canary-recovery model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"server": "cloudflare"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-2', model: 'gpt-6.1-sol' }, dataDir, 2004);

  // 会话完全自愈恢复！taskHalt 被清空，计数重置
  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt, null);
  assert.equal(state.consecutiveDegradedCount, 0);
});

test('exponential backoff progression: 15m -> 30m -> 60m -> exhausted and force resume', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'backoff_prog_logs.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-backoff-prog';
  const originalDb = process.env.CODEX_LOGS_DB;
  const originalBaseMs = process.env.MODELTRACE_BACKOFF_BASE_MS;
  process.env.CODEX_LOGS_DB = dbFile;
  process.env.MODELTRACE_BACKOFF_BASE_MS = '1000'; // 1s -> 2s -> 4s
  t.after(() => {
    if (originalDb === undefined) delete process.env.CODEX_LOGS_DB;
    else process.env.CODEX_LOGS_DB = originalDb;
    if (originalBaseMs === undefined) delete process.env.MODELTRACE_BACKOFF_BASE_MS;
    else process.env.MODELTRACE_BACKOFF_BASE_MS = originalBaseMs;
  });

  await handleHook({ session_id: sessionId, hook_event_name: 'SessionStart', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1000);

  // 连续 2 次降级 -> attempt 1 (1s)
  insertTestLog(dbFile, { id: 301, ts: 1789640001, threadId: sessionId, body: 'turn{thread.id=session-backoff-prog model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}' });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1001);
  insertTestLog(dbFile, { id: 302, ts: 1789640002, threadId: sessionId, body: 'turn{thread.id=session-backoff-prog model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}' });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1', model: 'gpt-6.1-sol' }, dataDir, 1002);

  let state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt.attempt, 1);
  assert.equal(state.taskHalt.durationMs, 1000);
  assert.equal(state.taskHalt.pausedUntil, 2002);

  // 第 1 次金丝雀失败：在 2003 毫秒金丝雀放行后，Stop 依然收到降级响应 -> 升级为 attempt 2 (2s)
  insertTestLog(dbFile, { id: 303, ts: 1789640003, threadId: sessionId, body: 'turn{thread.id=session-backoff-prog model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}' });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-2', model: 'gpt-6.1-sol' }, dataDir, 2005);

  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt.attempt, 2);
  assert.equal(state.taskHalt.durationMs, 2000);
  assert.equal(state.taskHalt.pausedUntil, 4005);

  // 第 2 次金丝雀失败：在 4006 毫秒放行后，Stop 依然降级 -> 升级为 attempt 3 (4s)
  insertTestLog(dbFile, { id: 304, ts: 1789640004, threadId: sessionId, body: 'turn{thread.id=session-backoff-prog model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}' });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-3', model: 'gpt-6.1-sol' }, dataDir, 4010);

  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt.attempt, 3);
  assert.equal(state.taskHalt.durationMs, 4000);
  assert.equal(state.taskHalt.pausedUntil, 8010);

  // 第 3 次金丝雀失败：在 8011 毫秒放行后，Stop 依然降级 -> 达到 maxAttempts (3) -> 触发 exhausted 永久停机！
  insertTestLog(dbFile, { id: 305, ts: 1789640005, threadId: sessionId, body: 'turn{thread.id=session-backoff-prog model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}' });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-4', model: 'gpt-6.1-sol' }, dataDir, 8015);

  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt.exhausted, true);
  assert.equal(state.taskHalt.pausedUntil, null);

  // 永久停机状态下，即使经过很长时间，PreToolUse 依然永久 deny
  const exhaustedPreTool = await handleHook({ session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-5', model: 'gpt-6.1-sol', tool_name: 'Bash', tool_input: { command: 'ls' } }, dataDir, 999999);
  assert.equal(exhaustedPreTool.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(exhaustedPreTool.hookSpecificOutput?.permissionDecisionReason?.includes('backoff attempts exhausted'));

  // 验证用户使用 --force 能够强制解除锁定并重置状态
  const forceResume = await run(['resume', '--session', sessionId, '--data-dir', dataDir, '--force', 'true']);
  assert.ok(forceResume);
  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt, null);
  assert.equal(state.consecutiveDegradedCount, 0);
});

