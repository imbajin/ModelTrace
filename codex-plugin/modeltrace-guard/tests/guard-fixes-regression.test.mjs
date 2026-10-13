import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { handleHook, ROOT } from '../scripts/guard.mjs';
import { handleBackgroundHook } from '../scripts/background.mjs';
import { withState, readState, sessionPath } from '../scripts/state.mjs';
import { pendingAlerts } from '../scripts/alerts.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'modeltrace-regression-test-'));
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

function createMockCodexClient({ initialStatus = 'active', failOnSet = false, errorMessage = 'Simulated app-server error' } = {}) {
  const state = {
    goal: { id: 'goal-1', status: initialStatus, description: 'Autonomous goal mode' },
    calls: [],
  };
  const client = {
    async request(method, params = {}) {
      state.calls.push({ method, params });
      if (method === 'thread/goal/get') {
        return { goal: structuredClone(state.goal) };
      }
      if (method === 'thread/goal/set') {
        if (failOnSet) {
          throw new Error(errorMessage);
        }
        state.goal.status = params.status;
        return { goal: structuredClone(state.goal) };
      }
      return {};
    },
    async close() {},
  };
  return { client, state };
}

// Issue 1: busy Stop stopping guarantee & goal pause
test('busy Stop returns continue: false, blocks on initial delivery, and pauses host goal', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-busy-stop-1';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-1';
    s.taskHalt = {
      id: 'telemetry-halt-101',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 900000,
      pausedUntil: 901000,
      canaryActive: false,
      exhausted: false,
    };
  });

  // Hold a busy lock
  const lockFile = sessionPath(dataDir, sessionId) + '.lock';
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() }));

  const mock = createMockCodexClient({ initialStatus: 'active' });
  const dependencies = { connect: () => mock.client };

  // First Stop delivery under busy lock: MUST block and return continue: false
  const stop1 = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1' },
    dataDir, 1010, undefined, { dependencies }
  );

  assert.equal(stop1.continue, false, 'busy Stop must command continue: false');
  assert.equal(stop1.decision, 'block', 'Initial delivery must block');
  assert.ok(stop1.reason?.includes('(host active goal paused)'), 'Reason should contain host active goal paused note');
  assert.equal(mock.state.goal.status, 'paused', 'Goal must be paused on app server');

  // Second Stop delivery with stop_hook_active: true: must NOT block again, but MUST return continue: false
  const stop2 = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: true },
    dataDir, 1020, undefined, { dependencies }
  );
  assert.equal(stop2.continue, false, 'Second stop must still enforce continue: false');
  assert.equal(stop2.decision, undefined, 'Second stop must not block');
  assert.ok(stop2.systemMessage?.includes('STOP THE ORIGINAL TASK NOW'));
});

test('busy Stop reports critical warning when goal pause fails', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-busy-stop-fail';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-1';
    s.taskHalt = {
      id: 'telemetry-halt-102',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 900000,
      pausedUntil: 901000,
      canaryActive: false,
      exhausted: false,
    };
  });

  const lockFile = sessionPath(dataDir, sessionId) + '.lock';
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() }));

  const mock = createMockCodexClient({ failOnSet: true, errorMessage: 'app-server connection refused' });
  const dependencies = { connect: () => mock.client };

  const stop = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1' },
    dataDir, 1010, undefined, { dependencies }
  );

  assert.equal(stop.continue, false, 'Must command continue: false');
  assert.ok(stop.reason?.includes('CRITICAL HOST GOAL WARNING: Automatic goal pause failed (app-server connection refused)'));
});

// Issue 2: 根/子会话遥测隔离
test('subagent legitimately using smaller model is not falsely reported as degraded', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'subagent_diff_model.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const parentSession = 'session-parent-large';
  const subagentSession = 'session-child-mini';

  const originalDb = process.env.CODEX_LOGS_DB;
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => {
    if (originalDb === undefined) delete process.env.CODEX_LOGS_DB;
    else process.env.CODEX_LOGS_DB = originalDb;
  });

  // Parent session configured with large model
  await withState(dataDir, parentSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
  });

  // Subagent registers with smaller model gpt-4o-mini
  await handleHook({
    session_id: subagentSession,
    parent_session_id: parentSession,
    agent_id: 'worker-sub',
    model: 'gpt-4o-mini',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo 1' },
  }, dataDir, 1000);

  // Subagent executes healthy request with gpt-4o-mini (no safety buffering)
  insertTestLog(dbFile, {
    id: 201,
    ts: 1789640001,
    threadId: subagentSession,
    body: 'turn{thread.id=session-child-mini model=gpt-4o-mini}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"server": "cloudflare"}',
  });

  // Root session runs PreToolUse
  const rootPreTool = await handleHook({
    session_id: parentSession,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'root work' },
  }, dataDir, 1002);

  // Should NOT be denied!
  assert.equal(rootPreTool.hookSpecificOutput?.permissionDecision, undefined);
  const state = await readState(dataDir, parentSession);
  assert.equal(state.taskHalt, null, 'Must not halt');
  assert.equal(pendingAlerts(state).length, 0, 'Must have zero alerts');
  assert.equal(state.consecutiveDegradedCount, 0);
});

test('older degraded root record is not shadowed by newer healthy subagent record', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'interleaved_logs.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const parentSession = 'session-interleaved-parent';
  const subagentSession = 'session-interleaved-child';

  const originalDb = process.env.CODEX_LOGS_DB;
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => {
    if (originalDb === undefined) delete process.env.CODEX_LOGS_DB;
    else process.env.CODEX_LOGS_DB = originalDb;
  });

  await withState(dataDir, parentSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
    s.subagentSessionIds = [subagentSession];
    s.subagentModels = { [subagentSession]: 'gpt-4o-mini' };
  });

  // Root session has degraded log at id: 301
  insertTestLog(dbFile, {
    id: 301,
    ts: 1789640010,
    threadId: parentSession,
    body: 'turn{thread.id=session-interleaved-parent model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });

  // Subagent session has NEWER healthy log at id: 302
  insertTestLog(dbFile, {
    id: 302,
    ts: 1789640020,
    threadId: subagentSession,
    body: 'turn{thread.id=session-interleaved-child model=gpt-4o-mini}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"server": "cloudflare"}',
  });

  // PreToolUse runs for parent
  const rootPreTool = await handleHook({
    session_id: parentSession,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'do task' },
  }, dataDir, 1001);

  // Root degradation must NOT be shadowed by the newer subagent log!
  assert.equal(rootPreTool.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(rootPreTool.systemMessage?.includes('本地 SQLite 遥测发现服务端降级指令'));

  // Ensure state recorded degradation for parent session
  const state = await readState(dataDir, parentSession);
  assert.equal(state.consecutiveDegradedCount, 1);
  assert.equal(state.lastSqliteLogIds?.[parentSession], 301);
  assert.equal(state.lastSqliteLogIds?.[subagentSession], 302);
});

// Issue 3: 检查真实 hook 调用路径 (handleBackgroundHook)
test('actual background-hook entry point receives subagent PostToolUse, tracks subagent, and catches degradation', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'bg_hook_subagent.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const parentSession = 'session-bg-parent';
  const subagentSession = 'session-bg-subagent';

  const env = {
    ...process.env,
    CODEX_LOGS_DB: dbFile,
    CODEX_THREAD_ID: parentSession,
  };

  await withState(dataDir, parentSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
  });

  // Insert degraded subagent log
  insertTestLog(dbFile, {
    id: 401,
    ts: 1789640001,
    threadId: subagentSession,
    body: 'turn{thread.id=session-bg-subagent model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });

  // Call handleBackgroundHook (the actual async hook handler configured in hooks.json for PostToolUse)
  const bgOutput = await handleBackgroundHook({
    session_id: subagentSession,
    parent_session_id: parentSession,
    agent_id: 'worker-bg',
    hook_event_name: 'PostToolUse',
    turn_id: 'sub-turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  }, dataDir, env);

  const state = await readState(dataDir, parentSession);
  assert.ok(state.subagentSessionIds?.includes(subagentSession), 'Subagent session ID must be recorded in parent state');
  assert.equal(state.consecutiveDegradedCount, 1, 'Degradation must be registered in parent state');
  assert.equal(pendingAlerts(state).length, 1, 'Alert must be queued');
});

// Issue 4: 限制 canary 放行 & SQLite 失败缺口报告
test('canary verification cooldown allows only a single trial tool and denies continuous tools until recovery is verified', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'canary_bound.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-canary-bounded';

  const originalDb = process.env.CODEX_LOGS_DB;
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => {
    if (originalDb === undefined) delete process.env.CODEX_LOGS_DB;
    else process.env.CODEX_LOGS_DB = originalDb;
  });

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
    s.taskHalt = {
      id: 'halt-canary-test',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 1000,
      pausedUntil: 2000, // Cooldown ends at 2000
      canaryActive: false,
      exhausted: false,
    };
  });

  // 1. Cooldown expired at 2001ms: FIRST PreToolUse is allowed as trial canary
  const trial1 = await handleHook({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    turn_id: 'turn-canary',
    tool_name: 'Bash',
    tool_input: { command: 'trial-probe' },
  }, dataDir, 2001);
  assert.deepEqual(trial1, {}, 'First tool call after cooldown must be allowed as canary');

  let state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt?.canaryActive, true);

  // 2. SECOND PreToolUse arrives while recovery is NOT yet confirmed: MUST BE DENIED!
  const trial2 = await handleHook({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    turn_id: 'turn-canary',
    tool_name: 'Bash',
    tool_input: { command: 'unauthorized-second-tool' },
  }, dataDir, 2002);
  assert.equal(trial2.hookSpecificOutput?.permissionDecision, 'deny', 'Second tool call must be denied while canary is pending');

  // 3. THIRD PreToolUse also denied
  const trial3 = await handleHook({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    turn_id: 'turn-canary',
    tool_name: 'Bash',
    tool_input: { command: 'unauthorized-third-tool' },
  }, dataDir, 2003);
  assert.equal(trial3.hookSpecificOutput?.permissionDecision, 'deny');

  // 4. Now server recovers: insert healthy log
  insertTestLog(dbFile, {
    id: 501,
    ts: 1789640050,
    threadId: sessionId,
    body: 'turn{thread.id=session-canary-bounded model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"server": "cloudflare"}',
  });

  // Stop hook runs and detects recovery
  await handleHook({
    session_id: sessionId,
    hook_event_name: 'Stop',
    turn_id: 'turn-canary',
  }, dataDir, 2004);

  state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt, null, 'Task halt must be cleared after verified recovery');

  // Next PreToolUse is now normally allowed
  const postRecovery = await handleHook({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    turn_id: 'turn-normal',
    tool_name: 'Bash',
    tool_input: { command: 'work' },
  }, dataDir, 2005);
  assert.equal(postRecovery.hookSpecificOutput?.permissionDecision, undefined);
});

test('SQLite failure reports coverage gap without falsely recovering or causing model degradation', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-sqlite-fail';

  // Point to invalid DB path to induce SQLite failure
  const env = {
    ...process.env,
    CODEX_LOGS_DB: path.join(dir, 'nonexistent_directory', 'broken.sqlite'),
  };

  // Case A: Session is halted with cooldown expired
  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
    s.taskHalt = {
      id: 'halt-sqlite-fail',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 1000,
      pausedUntil: 2000,
      canaryActive: false,
      exhausted: false,
    };
  });

  const resHalt = await handleHook({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'test' },
  }, dataDir, 2001, undefined, { env });

  // Canary check cannot be confirmed because SQLite query failed! Must not allow work!
  assert.equal(resHalt.hookSpecificOutput?.permissionDecision, 'deny');
  const stateHalt = await readState(dataDir, sessionId);
  assert.ok(stateHalt.taskHalt, 'Must not clear task halt on SQLite failure');
  assert.ok(stateHalt.lastTelemetryGap, 'Coverage gap must be recorded');

  // Case B: Normal active session with SQLite failure
  const normalSession = 'session-sqlite-fail-normal';
  await withState(dataDir, normalSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
  });

  const resNormal = await handleHook({
    session_id: normalSession,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'step' },
  }, dataDir, 2002, undefined, { env });

  const stateNormal = await readState(dataDir, normalSession);
  assert.equal(stateNormal.taskHalt, null, 'Must NOT falsely halt the task on SQLite failure');
  assert.equal(stateNormal.consecutiveDegradedCount, 0, 'Must NOT increment degraded count');
  assert.ok(stateNormal.lastTelemetryGap, 'Coverage gap must be recorded');
  assert.ok(resNormal.systemMessage?.includes('检测覆盖存在缺口'), 'Must notify user of coverage gap');
});

test('subagent running first with newer log does not advance parent lastSqliteLogId and does not shadow parent older degraded record', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'subagent_first.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const parentSession = 'session-parent-first';
  const subagentSession = 'session-child-first';

  const env = {
    ...process.env,
    CODEX_LOGS_DB: dbFile,
    CODEX_THREAD_ID: parentSession,
  };

  await withState(dataDir, parentSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
  });

  // 1. Subagent executes and creates newer healthy log at id: 502
  insertTestLog(dbFile, {
    id: 502,
    ts: 1789640050,
    threadId: subagentSession,
    body: 'turn{thread.id=session-child-first model=gpt-4o-mini}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"server": "cloudflare"}',
  });

  // Subagent runs background hook first
  await handleBackgroundHook({
    session_id: subagentSession,
    parent_session_id: parentSession,
    agent_id: 'sub-worker',
    model: 'gpt-4o-mini',
    hook_event_name: 'PostToolUse',
    turn_id: 'sub-turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo sub' },
  }, dataDir, env);

  const stateAfterSub = await readState(dataDir, parentSession);
  assert.equal(stateAfterSub.lastSqliteLogIds?.[subagentSession], 502, 'Subagent cursor is 502');
  assert.equal(stateAfterSub.lastSqliteLogIds?.[parentSession], undefined, 'Parent session cursor must NOT be advanced to 502 by subagent');

  // 2. Parent has older degraded log at id: 501 (< 502)
  insertTestLog(dbFile, {
    id: 501,
    ts: 1789640040,
    threadId: parentSession,
    body: 'turn{thread.id=session-parent-first model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });

  // 3. Parent runs PreToolUse
  const parentPreTool = await handleHook({
    session_id: parentSession,
    hook_event_name: 'PreToolUse',
    turn_id: 'parent-turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'do parent work' },
  }, dataDir, 1000, undefined, { env });

  // Degradation at 501 must be detected because parent cursor was not advanced by subagent!
  assert.equal(parentPreTool.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(parentPreTool.systemMessage?.includes('本地 SQLite 遥测发现服务端降级指令'));
  const finalState = await readState(dataDir, parentSession);
  assert.equal(finalState.consecutiveDegradedCount, 1);
  assert.equal(finalState.lastSqliteLogIds?.[parentSession], 501);
});

test('actual production CLI entry point processes subagent PostToolUse end-to-end', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'cli_bg_subagent.sqlite');
  initTestDb(dbFile);
  const dataDir = path.join(dir, 'data');
  const parentSession = 'session-cli-parent';
  const subagentSession = 'session-cli-subagent';

  await withState(dataDir, parentSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
  });

  insertTestLog(dbFile, {
    id: 601,
    ts: 1789640001,
    threadId: subagentSession,
    body: 'turn{thread.id=session-cli-subagent model=gpt-6.1-sol}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-6-luna"}',
  });

  const subagentEvent = {
    session_id: subagentSession,
    parent_session_id: parentSession,
    agent_id: 'cli-worker',
    hook_event_name: 'PostToolUse',
    turn_id: 'sub-turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo cli' },
  };

  const env = {
    ...process.env,
    CODEX_LOGS_DB: dbFile,
    CODEX_THREAD_ID: parentSession,
  };

  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'guard.mjs'),
    'background-hook',
    '--data-dir', dataDir,
  ], {
    input: JSON.stringify(subagentEvent),
    encoding: 'utf8',
    env,
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  const parentState = await readState(dataDir, parentSession);
  assert.ok(parentState.subagentSessionIds?.includes(subagentSession), 'Subagent registered via CLI');
  assert.equal(parentState.consecutiveDegradedCount, 1, 'Degradation registered in parent via CLI');
});

test('continuous PreToolUse requests when SQLite telemetry fails report coverage gap in systemMessage without false halts', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const normalSession = 'session-continuous-gap';

  const env = {
    ...process.env,
    CODEX_LOGS_DB: path.join(dir, 'broken_dir', 'unreachable.sqlite'),
  };

  await withState(dataDir, normalSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
  });

  // Request 1: PreToolUse with failing SQLite
  const pre1 = await handleHook({
    session_id: normalSession,
    hook_event_name: 'PreToolUse',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'tool 1' },
  }, dataDir, 1001, undefined, { env });

  assert.equal(pre1.hookSpecificOutput?.permissionDecision, undefined, 'Must not deny normal work');
  assert.ok(pre1.systemMessage?.includes('检测覆盖存在缺口'), 'PreToolUse must inform of coverage gap');

  // Request 2: Consecutive PreToolUse with failing SQLite
  const pre2 = await handleHook({
    session_id: normalSession,
    hook_event_name: 'PreToolUse',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'tool 2' },
  }, dataDir, 1002, undefined, { env });

  assert.equal(pre2.hookSpecificOutput?.permissionDecision, undefined);
  assert.ok(pre2.systemMessage?.includes('检测覆盖存在缺口'), 'Consecutive PreToolUse must also inform of gap');

  const state = await readState(dataDir, normalSession);
  assert.equal(state.taskHalt, null, 'Must not halt session on telemetry errors');
  assert.equal(state.consecutiveDegradedCount, 0, 'Degraded count must stay 0');
  assert.ok(state.lastTelemetryGap);
});

test('busy Stop completes well within 5-second budget and reports goal pause failure', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-busy-stop-fast';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-fast';
    s.taskHalt = {
      id: 'telemetry-halt-fast',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 900000,
      pausedUntil: 901000,
      canaryActive: false,
      exhausted: false,
    };
  });

  const lockFile = sessionPath(dataDir, sessionId) + '.lock';
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() }));

  const mock = createMockCodexClient({ failOnSet: true, errorMessage: 'app-server timed out' });
  const dependencies = { connect: () => mock.client, timeoutMs: 500 };

  const start = performance.now();
  const stop = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-fast' },
    dataDir, 1010, undefined, { dependencies }
  );
  const elapsed = performance.now() - start;

  assert.equal(stop.continue, false, 'Must command continue: false');
  assert.equal(stop.decision, 'block', 'Initial delivery must block');
  assert.ok(stop.reason?.includes('CRITICAL HOST GOAL WARNING: Automatic goal pause failed (app-server timed out)'));
  assert.ok(elapsed < 3500, `Execution took ${elapsed}ms, which must be well under the 5000ms hook timeout`);
});

test('busy lock PreToolUse fallback rejects consecutive canary requests without modifying state', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-busy-canary';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-canary-1';
    s.taskHalt = {
      id: 'telemetry-halt-canary',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 900000,
      pausedUntil: 2000,
      canaryActive: false,
      exhausted: false,
    };
  });

  const lockFile = sessionPath(dataDir, sessionId) + '.lock';
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() }));

  const now = 2500;

  const res1 = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-canary-1', tool_name: 'Bash', tool_input: { command: 'echo canary-1' } },
    dataDir, now, undefined, { dependencies: {} }
  );
  assert.equal(res1.hookSpecificOutput?.permissionDecision, 'deny', 'Busy PreToolUse must not authorize canary');
  assert.ok(res1.systemMessage?.includes('ModelTrace Guard: STOP THE ORIGINAL TASK NOW'));

  const res2 = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-canary-1', tool_name: 'Bash', tool_input: { command: 'echo canary-2' } },
    dataDir, now + 10, undefined, { dependencies: {} }
  );
  assert.equal(res2.hookSpecificOutput?.permissionDecision, 'deny', 'Consecutive busy PreToolUse must also be denied');

  const stateUnderLock = await readState(dataDir, sessionId);
  assert.equal(stateUnderLock.taskHalt?.canaryActive, false, 'canaryActive must not be consumed by busy fallback');

  await rm(lockFile, { force: true });

  const res3 = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-canary-1', tool_name: 'Bash', tool_input: { command: 'echo canary-3' } },
    dataDir, now + 20, undefined, { dependencies: {} }
  );
  assert.equal(res3.hookSpecificOutput?.permissionDecision, undefined, 'Normal lock must allow the single trial canary');
  const finalState = await readState(dataDir, sessionId);
  assert.equal(finalState.taskHalt?.canaryActive, true, 'canaryActive is now marked true');
});

test('query failure after canary trial preserves canaryActive, and recovery to empty db does not re-grant canary', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const dbFile = path.join(dir, 'test_logs.sqlite');
  initTestDb(dbFile);
  const sessionId = 'session-canary-fail-empty';
  const env = { CODEX_LOGS_DB: dbFile };

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-1';
    s.taskHalt = {
      id: 'telemetry-halt-probe',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 900000,
      pausedUntil: 2000,
      canaryActive: false,
      exhausted: false,
    };
  });

  const pre1 = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: 'echo trial' } },
    dataDir, 2500, undefined, { env }
  );
  assert.equal(pre1.hookSpecificOutput?.permissionDecision, undefined, 'Canary permitted');
  const stateAfterPre = await readState(dataDir, sessionId);
  assert.equal(stateAfterPre.taskHalt?.canaryActive, true, 'Canary active');

  const corruptEnv = { CODEX_LOGS_DB: path.join(dir, 'nonexistent_invalid.sqlite') };
  const postFail = await handleHook(
    { session_id: sessionId, hook_event_name: 'PostToolUse', turn_id: 'turn-1' },
    dataDir, 2510, undefined, { env: corruptEnv }
  );
  assert.ok(postFail.systemMessage?.includes('CRITICAL TELEMETRY COVERAGE GAP') || postFail.systemMessage?.includes('遥测检查失败'), 'Reports gap');
  const stateAfterFail = await readState(dataDir, sessionId);
  assert.equal(stateAfterFail.taskHalt?.canaryActive, true, 'Query failure MUST NOT reset canaryActive to false');
  assert.ok(stateAfterFail.lastTelemetryGap, 'Coverage gap recorded');

  const postRecover = await handleHook(
    { session_id: sessionId, hook_event_name: 'PostToolUse', turn_id: 'turn-1' },
    dataDir, 2520, undefined, { env }
  );
  const stateAfterRecover = await readState(dataDir, sessionId);
  assert.equal(stateAfterRecover.lastTelemetryGap, null, 'Gap cleared on recovery');
  assert.equal(stateAfterRecover.taskHalt?.canaryActive, true, 'canaryActive still true because no new healthy record');

  const pre2 = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: 'echo second-tool' } },
    dataDir, 2530, undefined, { env }
  );
  assert.equal(pre2.hookSpecificOutput?.permissionDecision, 'deny', 'Must not re-grant canary when db is empty');
  assert.ok(pre2.hookSpecificOutput?.permissionDecisionReason?.includes('STOP THE ORIGINAL TASK NOW'));
});

test('end-to-end deadline budget bounds slow connect, slow RPCs, and slow cleanup', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const sessionId = 'session-slow-stages';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-slow';
    s.taskHalt = {
      id: 'telemetry-halt-slow',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 900000,
      pausedUntil: 901000,
      canaryActive: false,
      exhausted: false,
    };
  });

  const slowMockClient = {
    async request(method, params, timeout) {
      await new Promise((r) => setTimeout(r, 200));
      if (method === 'thread/goal/get') {
        return { goal: { id: 'goal-1', status: 'active' } };
      }
      if (method === 'thread/goal/set') {
        return { goal: { id: 'goal-1', status: 'paused' } };
      }
      return {};
    },
    async close() {
      await new Promise((r) => setTimeout(r, 1000));
    },
  };

  const dependencies = {
    connect: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return slowMockClient;
    },
    hookTimeoutMs: 500,
  };

  const start = performance.now();
  const stopRes = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-slow' },
    dataDir, 1010, undefined, { dependencies }
  );
  const elapsed = performance.now() - start;

  assert.equal(stopRes.continue, false, 'Must command continue: false');
  assert.equal(stopRes.decision, 'block', 'Initial delivery must block');
  assert.ok(elapsed < 800, `Execution took ${elapsed}ms, which must be well bounded by 500ms budget + small buffer`);
  assert.ok(stopRes.reason?.includes('CRITICAL HOST GOAL WARNING: Automatic goal pause failed'), 'Reports unconfirmed pause');
  assert.ok(stopRes.reason?.includes('timed out'), 'Explicitly indicates timeout');

  const state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt?.goalPaused, false, 'Goal pause must be reported unconfirmed');
  assert.equal(state.taskHalt?.hostConfirmed, false);
});

test('legacy cursor from subagent is migrated to subagent and does not shadow earlier degraded record of root session', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const dbFile = path.join(dir, 'test_logs.sqlite');
  initTestDb(dbFile);

  const rootSession = 'session-root-upgrade';
  const subagentSession = 'session-subagent-upgrade';
  const env = { CODEX_LOGS_DB: dbFile, MODELTRACE_TELEMETRY_HALT_COUNT: '1' };

  insertTestLog(dbFile, {
    id: 200,
    ts: 2000,
    threadId: subagentSession,
    body: 'method=POST status=200 path=/responses headers={"x-codex-safety-buffering-enabled": "false"} model="gpt-6.1-sol"',
  });

  insertTestLog(dbFile, {
    id: 150,
    ts: 1500,
    threadId: rootSession,
    body: 'method=POST status=200 path=/responses headers={"x-codex-safety-buffering-enabled": "true", "x-codex-faster-model-used": "gpt-5.6-luna"} model="gpt-6.1-sol"',
  });

  await withState(dataDir, rootSession, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
    s.subagentSessionIds = [subagentSession];
    s.lastSqliteLogId = 200;
    s.lastTelemetry = {
      sessionId: subagentSession,
      logId: 200,
      degraded: false,
      requestedModel: 'gpt-6.1-sol',
      fasterModel: null,
    };
    delete s.lastSqliteLogIds;
  });

  const preRes = await handleHook(
    { session_id: rootSession, hook_event_name: 'PreToolUse', turn_id: 'turn-root-1', tool_name: 'Bash', tool_input: { command: 'echo work' } },
    dataDir, 2100, undefined, { env }
  );

  const stateAfter = await readState(dataDir, rootSession);
  assert.equal(stateAfter.lastSqliteLogIds?.[subagentSession], 200, 'Subagent cursor retained at 200');
  assert.equal(stateAfter.lastSqliteLogIds?.[rootSession], 150, 'Root session cursor established at 150');
  assert.equal(stateAfter.taskHalt?.source, 'telemetry', 'Root session must halt on degraded record 150');
  assert.equal(preRes.hookSpecificOutput?.permissionDecision, 'deny', 'PreToolUse must be denied for degraded root session');

  const unconfirmedRoot = 'session-root-unconfirmed';
  insertTestLog(dbFile, {
    id: 250,
    ts: 2500,
    threadId: unconfirmedRoot,
    body: 'method=POST status=200 path=/responses headers={"x-codex-safety-buffering-enabled": "true", "x-codex-faster-model-used": "gpt-5.6-luna"} model="gpt-6.1-sol"',
  });
  await withState(dataDir, unconfirmedRoot, (s) => {
    s.enabled = true;
    s.model = 'gpt-6.1-sol';
    s.expected = 'gpt-6.1-sol';
    s.lastSqliteLogId = 300;
    s.lastTelemetry = null;
    delete s.lastSqliteLogIds;
  });

  const unconfirmedRes = await handleHook(
    { session_id: unconfirmedRoot, hook_event_name: 'PreToolUse', turn_id: 'turn-unconfirmed-1', tool_name: 'Bash', tool_input: { command: 'echo work' } },
    dataDir, 2600, undefined, { env }
  );
  const unconfirmedState = await readState(dataDir, unconfirmedRoot);
  assert.equal(unconfirmedState.lastSqliteLogIds?.[unconfirmedRoot], 250, 'Root session cursor established at 250');
  assert.equal(unconfirmedState.taskHalt?.source, 'telemetry', 'Must not skip root session record when cursor source was unconfirmed');
  assert.equal(unconfirmedRes.hookSpecificOutput?.permissionDecision, 'deny');
});

test('adaptive stage budgeting allows fast pause operations to succeed with small total budget', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const sessionId = '00000000-0000-0000-0000-000000000001';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-fast-small-budget';
    s.taskHalt = {
      id: 'telemetry-halt-fast',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6.1-sol',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'Safety Buffering',
      attempt: 1,
      maxAttempts: 3,
      durationMs: 900000,
      pausedUntil: 901000,
      canaryActive: false,
      exhausted: false,
    };
  });

  const fastMockClient = {
    async request(method, params, timeout) {
      await new Promise((r) => setTimeout(r, 20));
      if (method === 'thread/goal/get') {
        return { goal: { id: 'goal-1', status: 'active' } };
      }
      if (method === 'thread/goal/set') {
        return { goal: { id: 'goal-1', status: 'paused' } };
      }
      return {};
    },
    async close() {
      await new Promise((r) => setTimeout(r, 10));
    },
  };

  const dependencies = {
    connect: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return fastMockClient;
    },
    hookTimeoutMs: 350,
  };

  const start = performance.now();
  const stopRes = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-fast-small-budget' },
    dataDir, 1010, undefined, { dependencies }
  );
  const elapsed = performance.now() - start;

  assert.equal(stopRes.continue, false);
  assert.equal(stopRes.decision, 'block');
  assert.ok(elapsed < 600, `Execution took ${elapsed}ms, bounded by small budget`);
  const state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt?.goalPaused, true, 'Goal pause must succeed under tight budget with fast stages');
  assert.equal(state.taskHalt?.hostConfirmed, true);
});

test('connect timeout triggers cleanup on late-resolving client to prevent orphan process leaks', { timeout: 10000 }, async (t) => {
  const { pauseThreadGoal } = await import('../scripts/app-server-client.mjs');
  let closed = false;
  let killed = false;
  const mockChild = {
    kill() { killed = true; }
  };
  const mockClient = {
    child: mockChild,
    async close() { closed = true; }
  };
  const lateConnect = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return mockClient;
  };

  let caughtError = null;
  try {
    await pauseThreadGoal('00000000-0000-0000-0000-000000000002', process.env, {
      connect: lateConnect,
      hookTimeoutMs: 60,
    });
  } catch (err) {
    caughtError = err;
  }
  assert.ok(caughtError !== null);
  assert.ok(caughtError.message.includes('timed out'));

  // Wait for late connect to resolve
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(closed === true || killed === true, 'Late-resolving client must be cleaned up to prevent process leak');
});

test('slow SQLite queries respect the hook deadline budget without exceeding total timeout', { timeout: 10000 }, async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const dbFile = path.join(dir, 'test_logs.sqlite');
  initTestDb(dbFile);
  const sessionId = 'session-sqlite-slow';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.turn = 'turn-sqlite-slow';
  });

  const slowExecFn = async (dbPath, sql, options) => {
    await new Promise((r) => setTimeout(r, options?.timeout ? options.timeout + 100 : 2500));
    throw new Error('sqlite query timed out');
  };

  const start = performance.now();
  const res = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-sqlite-slow', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
    dataDir, 1000, undefined, { dependencies: { hookTimeoutMs: 400 }, env: { CODEX_LOGS_DB: dbFile } }
  );
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 1000, `Execution took ${elapsed}ms, bounded by deadline`);
  const state = await readState(dataDir, sessionId);
  assert.ok(state.lastTelemetryGap !== undefined);
});

