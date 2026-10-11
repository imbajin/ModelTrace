import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { handleHook, ROOT, isControlCommand, run } from '../scripts/guard.mjs';
import { pauseThreadGoal, resumeThreadGoal } from '../scripts/app-server-client.mjs';
import { withState, readState } from '../scripts/state.mjs';
import { pendingAlerts } from '../scripts/alerts.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'modeltrace-goal-test-'));
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
    closed: false,
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
      throw new Error(`Unexpected method: ${method}`);
    },
    async close() {
      state.closed = true;
    },
  };
  return { client, state };
}

test('Stop hook terminates continuation loop: blocks exactly once, then delivers systemMessage without block on subsequent turns', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const dbFile = path.join(dir, 'logs.sqlite');
  initTestDb(dbFile);

  const sessionId = 'session-loop-termination';
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => { delete process.env.CODEX_LOGS_DB; });

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
  });

  // Step 1: Insert 2 consecutive degradations to trigger hard circuit breaker
  insertTestLog(dbFile, {
    id: 101, ts: 1789640001, threadId: sessionId,
    body: 'turn{thread.id=session-loop-termination model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "85"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }, dataDir, 1000);

  insertTestLog(dbFile, {
    id: 102, ts: 1789640002, threadId: sessionId,
    body: 'turn{thread.id=session-loop-termination model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna", "x-codex-primary-used-percent": "90"}',
  });

  // Mock app server fixture
  const mock = createMockCodexClient({ initialStatus: 'active' });
  const dependencies = { connect: () => mock.client };

  // Turn 1 Stop: MUST block once to inform the model
  const stopTurn1 = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1' },
    dataDir, 1010, undefined, { dependencies }
  );
  assert.equal(stopTurn1.decision, 'block', 'Initial halt stop must command block once');
  assert.equal(stopTurn1.continue, false, 'Turn 1 must specify continue: false');
  assert.ok(stopTurn1.systemMessage?.includes('服务端降级指令'));
  assert.ok(stopTurn1.reason?.includes('(host active goal paused)'), 'Reason should contain host active goal paused');
  assert.ok(mock.state.goal.status === 'paused', 'Goal must be paused on app-server');

  // Verify state has recorded host goal pause
  const stateAfterTurn1 = await readState(dataDir, sessionId);
  assert.equal(stateAfterTurn1.taskHalt.goalPaused, true);
  assert.equal(stateAfterTurn1.taskHalt.hostConfirmed, true);
  assert.equal(stateAfterTurn1.taskHalt.haltStopDelivered, true);

  // Turn 2 Stop: In autonomous mode, the continuation turn MUST NOT block
  const stopTurn2 = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-2' },
    dataDir, 1020, undefined, { dependencies }
  );
  assert.equal(stopTurn2.decision, undefined, 'Turn 2 must NOT block');
  assert.equal(stopTurn2.continue, false, 'Turn 2 must specify continue: false');
  assert.ok(stopTurn2.systemMessage?.includes('STOP THE ORIGINAL TASK NOW'));

  // Turn 3 Stop: Must NOT block
  const stopTurn3 = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-3' },
    dataDir, 1030, undefined, { dependencies }
  );
  assert.equal(stopTurn3.decision, undefined, 'Turn 3 must NOT block');
  assert.equal(stopTurn3.continue, false, 'Turn 3 must specify continue: false');
  assert.ok(stopTurn3.systemMessage?.includes('STOP THE ORIGINAL TASK NOW'));

  // Turn 4 Stop: Must NOT block
  const stopTurn4 = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-4' },
    dataDir, 1040, undefined, { dependencies }
  );
  assert.equal(stopTurn4.decision, undefined, 'Turn 4 must NOT block');
  assert.equal(stopTurn4.continue, false, 'Turn 4 must specify continue: false');
  assert.ok(stopTurn4.systemMessage?.includes('STOP THE ORIGINAL TASK NOW'));

  // PreToolUse in subsequent turns: Business tools are strictly blocked
  const preToolTurn4 = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-4', tool_name: 'Bash', tool_input: { command: 'git commit' } },
    dataDir, 1045, undefined, { dependencies }
  );
  assert.equal(preToolTurn4.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(preToolTurn4.hookSpecificOutput?.permissionDecisionReason?.includes('STOP THE ORIGINAL TASK NOW'));
});

test('pauseThreadGoal and resumeThreadGoal manage goal status transitions and handle thread without goal', async (t) => {
  // Test 1: Active goal -> paused
  const mock1 = createMockCodexClient({ initialStatus: 'active' });
  const pauseRes1 = await pauseThreadGoal('thread-1', {}, { connect: () => mock1.client });
  assert.equal(pauseRes1.hasGoal, true);
  assert.equal(pauseRes1.paused, true);
  assert.equal(pauseRes1.previousStatus, 'active');
  assert.equal(mock1.state.goal.status, 'paused');
  assert.equal(mock1.state.closed, true);

  // Test 2: Resume -> active
  const resumeRes1 = await resumeThreadGoal('thread-1', {}, { connect: () => mock1.client });
  assert.equal(resumeRes1.hasGoal, true);
  assert.equal(resumeRes1.resumed, true);
  assert.equal(mock1.state.goal.status, 'active');

  // Test 3: Thread without goal (goal: null)
  const noGoalClient = {
    async request(method) {
      if (method === 'thread/goal/get') return { goal: null };
      throw new Error('Unexpected');
    },
    async close() {},
  };
  const noGoalPause = await pauseThreadGoal('thread-no-goal', {}, { connect: () => noGoalClient });
  assert.equal(noGoalPause.hasGoal, false);
  assert.equal(noGoalPause.paused, true);

  const noGoalResume = await resumeThreadGoal('thread-no-goal', {}, { connect: () => noGoalClient });
  assert.equal(noGoalResume.hasGoal, false);
  assert.equal(noGoalResume.resumed, false);

  // Test 4: Goal already complete or abandoned is not reactivated by resume
  const completeMock = createMockCodexClient({ initialStatus: 'complete' });
  const completeResume = await resumeThreadGoal('thread-complete', {}, { connect: () => completeMock.client });
  assert.equal(completeResume.hasGoal, true);
  assert.equal(completeResume.resumed, false);
  assert.equal(completeMock.state.goal.status, 'complete');
});

test('Explicit host error reporting when thread/goal/set fails', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const dbFile = path.join(dir, 'logs.sqlite');
  initTestDb(dbFile);

  const sessionId = 'session-host-failure';
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => { delete process.env.CODEX_LOGS_DB; });

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
  });

  // Insert 2 degradations with url containing /responses
  insertTestLog(dbFile, {
    id: 201, ts: 1789640001, threadId: sessionId,
    body: 'turn{thread.id=session-host-failure model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }, dataDir, 1000);

  insertTestLog(dbFile, {
    id: 202, ts: 1789640002, threadId: sessionId,
    body: 'turn{thread.id=session-host-failure model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });

  // Mock app server fixture that FAILS on thread/goal/set
  const failingMock = createMockCodexClient({ initialStatus: 'active', failOnSet: true, errorMessage: 'Network connection reset by peer' });
  const dependencies = { connect: () => failingMock.client };

  const stopRes = await handleHook(
    { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1' },
    dataDir, 1010, undefined, { dependencies }
  );
  assert.ok(stopRes.reason?.includes('CRITICAL HOST GOAL WARNING: Automatic goal pause failed (Network connection reset by peer)'), 'Direct hook reason must contain host warning');
  assert.ok(stopRes.systemMessage?.includes('CRITICAL HOST GOAL WARNING: Automatic goal pause failed (Network connection reset by peer)'), 'Direct systemMessage must contain host warning');

  const state = await readState(dataDir, sessionId);
  assert.ok(state.taskHalt, 'taskHalt must be created');
  assert.equal(state.taskHalt.goalPaused, false, 'Goal must NOT be marked paused');
  assert.equal(state.taskHalt.hostConfirmed, false, 'Host must NOT be marked confirmed');
  assert.ok(state.taskHalt.hostError.includes('Network connection reset by peer'), 'Host error must be explicitly recorded');

  // Verify host error appears in control context / status report
  const statusRes = await run(['status', '--session', sessionId, '--data-dir', dataDir]);
  assert.ok(statusRes.controlContext.includes('CRITICAL HOST GOAL WARNING: Automatic goal pause failed (Network connection reset by peer)'));
  assert.ok(statusRes.controlContext.includes('The active goal may continue scheduling turns'));
});

test('Restricted control channel: allows status, check-sqlite, stop, resume, acknowledge while strictly denying business tools', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const sessionId = 'session-control-channel';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
    s.taskHalt = {
      id: 'halt-test-123',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6-astra',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'test halt',
    };
  });

  const guardScript = path.join(ROOT, 'scripts', 'guard.mjs');

  // Allowed control commands
  const allowedCommands = [
    `node "${guardScript}" status`,
    `node "${guardScript}" status --session ${sessionId}`,
    `node "${guardScript}" check-sqlite`,
    `node "${guardScript}" stop`,
    `node "${guardScript}" resume --halt halt-test-123`,
    `node "${guardScript}" acknowledge --alert telemetry-1`,
  ];

  for (const cmd of allowedCommands) {
    const res = await handleHook(
      { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: cmd } },
      dataDir, 1001
    );
    assert.deepEqual(res, {}, `Command '${cmd}' should be permitted as control command`);
  }

  // Denied business / disguised commands
  const deniedCommands = [
    'ls -la',
    'rm -rf /tmp/test',
    'git status',
    `echo "node ${guardScript} status"`,
    `cat "${guardScript}"`,
    `node "${guardScript}" probe --challenge 123`,
    `node "${guardScript}" doctor`,
    `python -c "print(1)"`,
  ];

  for (const cmd of deniedCommands) {
    const res = await handleHook(
      { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: cmd } },
      dataDir, 1002
    );
    assert.equal(res.hookSpecificOutput?.permissionDecision, 'deny', `Command '${cmd}' must be denied`);
  }
});

test('Explicit user-authorized recovery: resume requires current halt ID and unpauses host goal', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const sessionId = 'session-recovery';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
    s.taskHalt = {
      id: 'halt-valid-456',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6-astra',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'telemetry degradation',
      goalPaused: true,
      hostConfirmed: true,
    };
  });

  // Rejection on missing or wrong halt ID
  await assert.rejects(
    () => run(['resume', '--session', sessionId, '--data-dir', dataDir]),
    /Explicit user-approved resume requires the current halt ID/
  );
  await assert.rejects(
    () => run(['resume', '--session', sessionId, '--data-dir', dataDir, '--halt', 'wrong-id']),
    /Explicit user-approved resume requires the current halt ID/
  );

  // Resume with correct halt ID unpauses host goal
  const mock = createMockCodexClient({ initialStatus: 'paused' });
  const resumeResult = await run(
    ['resume', '--session', sessionId, '--data-dir', dataDir, '--halt', 'halt-valid-456'],
    process.env,
    { dependencies: { connect: () => mock.client } }
  );

  assert.equal(resumeResult.taskHalt, null, 'taskHalt must be cleared');
  assert.equal(mock.state.goal.status, 'active', 'Host goal must be resumed to active');

  const state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt, null);
  const resumeEvent = state.events.find((e) => e.type === 'task_resumed');
  assert.ok(resumeEvent, 'task_resumed event must be logged');
  assert.equal(resumeEvent.halt, 'halt-valid-456');
});

test('Halt persistence: subsequent healthy telemetry records do not auto-clear taskHalt', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const dbFile = path.join(dir, 'logs.sqlite');
  initTestDb(dbFile);

  const sessionId = 'session-persistence';
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => { delete process.env.CODEX_LOGS_DB; });

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
    s.taskHalt = {
      id: 'halt-fingerprint-mismatch',
      at: 1000,
      source: 'fingerprint',
      expected: 'gpt-6-astra',
      actual: 'gpt-5-luna',
      retryCount: 3,
      reason: 'confirmed mismatch',
      canaryActive: false,
    };
  });

  // Insert a healthy (non-degraded) log into SQLite
  insertTestLog(dbFile, {
    id: 301, ts: 1789640001, threadId: sessionId,
    body: 'turn{thread.id=session-persistence model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "false"}',
  });

  // Hook run should NOT clear taskHalt
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }, dataDir, 2000);

  const state = await readState(dataDir, sessionId);
  assert.ok(state.taskHalt, 'taskHalt must remain active despite healthy telemetry');
  assert.equal(state.taskHalt.id, 'halt-fingerprint-mismatch');
});

test('Duplicate alert suppression during halt', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const dbFile = path.join(dir, 'logs.sqlite');
  initTestDb(dbFile);

  const sessionId = 'session-dedup';
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => { delete process.env.CODEX_LOGS_DB; });

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
  });

  // Degraded log 1
  insertTestLog(dbFile, {
    id: 401, ts: 1789640001, threadId: sessionId,
    body: 'turn{thread.id=session-dedup model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }, dataDir, 1000);

  // Degraded log 2 -> halts
  insertTestLog(dbFile, {
    id: 402, ts: 1789640002, threadId: sessionId,
    body: 'turn{thread.id=session-dedup model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1' }, dataDir, 1010);

  const stateHalted = await readState(dataDir, sessionId);
  const alertCountAtHalt = pendingAlerts(stateHalted).length;

  // Degraded log 3, 4 while halted -> must NOT append duplicate pending alerts
  insertTestLog(dbFile, {
    id: 403, ts: 1789640003, threadId: sessionId,
    body: 'turn{thread.id=session-dedup model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2' }, dataDir, 1020);

  insertTestLog(dbFile, {
    id: 404, ts: 1789640004, threadId: sessionId,
    body: 'turn{thread.id=session-dedup model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}',
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-2' }, dataDir, 1030);

  const stateFinal = await readState(dataDir, sessionId);
  assert.equal(pendingAlerts(stateFinal).length, alertCountAtHalt, 'Pending alerts count must not increase indefinitely during halt');
});

test('PreToolUse hook pauses host goal when taskHalt is active or triggered', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const sessionId = 'session-pretool-pause';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
    s.taskHalt = {
      id: 'halt-pretool-1',
      at: 1000,
      source: 'telemetry',
      expected: 'gpt-6-astra',
      actual: 'gpt-5.6-luna',
      retryCount: 2,
      reason: 'telemetry degradation',
      goalPaused: false,
      hostConfirmed: false,
    };
  });

  const mock = createMockCodexClient({ initialStatus: 'active' });
  const preToolRes = await handleHook(
    { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: 'git commit' } },
    dataDir, 1005, undefined, { dependencies: { connect: () => mock.client } }
  );

  assert.equal(preToolRes.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(mock.state.goal.status === 'paused', 'Goal must be paused on app-server during PreToolUse');
  assert.ok(preToolRes.hookSpecificOutput?.permissionDecisionReason?.includes('(host active goal paused)'));

  const state = await readState(dataDir, sessionId);
  assert.equal(state.taskHalt.goalPaused, true);
  assert.equal(state.taskHalt.hostConfirmed, true);
});

test('Lock contention: concurrent hooks and slow goal pause serialize cleanly without deadlock or lock timeout', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const sessionId = 'session-lock-contention';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.taskHalt = {
      id: 'halt-contention-1',
      at: 1000,
      retryCount: 2,
      goalPaused: false,
      hostConfirmed: false,
    };
  });

  // Slow mock client with 100ms delay to exercise concurrent state access during host RPC
  const slowMock = {
    status: 'active',
    async request(method, params) {
      await new Promise((r) => setTimeout(r, 100));
      if (method === 'thread/goal/get') return { goal: { id: 'g1', status: this.status } };
      if (method === 'thread/goal/set') { this.status = params.status; return { goal: { id: 'g1', status: this.status } }; }
      throw new Error(`Unexpected: ${method}`);
    },
    async close() {},
  };

  const guardScript = path.join(ROOT, 'scripts', 'guard.mjs');

  // Launch hook with goal pause concurrently with state operations
  const [stopRes, , preToolRes] = await Promise.all([
    handleHook(
      { session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1' },
      dataDir, 1010, undefined, { dependencies: { connect: () => slowMock } }
    ),
    withState(dataDir, sessionId, (s) => {
      s.workTools = (s.workTools || 0) + 1;
    }),
    handleHook(
      { session_id: sessionId, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: `node "${guardScript}" status` } },
      dataDir, 1015, undefined, { dependencies: { connect: () => slowMock } }
    ),
  ]);

  assert.equal(stopRes.decision, 'block');
  assert.equal(slowMock.status, 'paused');
  assert.deepEqual(preToolRes, {});
  const finalState = await readState(dataDir, sessionId);
  assert.equal(finalState.workTools, 1);
  assert.equal(finalState.taskHalt.goalPaused, true);
  assert.equal(finalState.taskHalt.hostConfirmed, true);
});

test('Resume failure retains taskHalt in state and rejects with explicit actionable error', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const sessionId = 'session-resume-fail';

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.taskHalt = {
      id: 'halt-resume-err',
      at: 1000,
      retryCount: 2,
      goalPaused: true,
      hostConfirmed: true,
    };
  });

  const failingMock = createMockCodexClient({ initialStatus: 'paused', failOnSet: true, errorMessage: 'Timeout contacting app server' });
  await assert.rejects(
    () => run(['resume', '--session', sessionId, '--data-dir', dataDir, '--halt', 'halt-resume-err'], process.env, { dependencies: { connect: () => failingMock.client } }),
    /Host goal resume failed: Timeout contacting app server.*Task halt has been retained; retry with resume --halt halt-resume-err/
  );

  const state = await readState(dataDir, sessionId);
  assert.ok(state.taskHalt, 'taskHalt must remain active after failed resume');
  assert.equal(state.taskHalt.id, 'halt-resume-err');
  assert.ok(state.taskHalt.hostError.includes('Resume failed'));
});

test('Production hook entry execution via stdio with mock Codex app-server stops autonomous goal scheduling without looping', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'guard-data');
  const dbFile = path.join(dir, 'logs.sqlite');
  initTestDb(dbFile);

  const sessionId = '01a12c87-1234-4567-89ab-cdef01234567';
  process.env.CODEX_LOGS_DB = dbFile;
  t.after(() => { delete process.env.CODEX_LOGS_DB; });

  await withState(dataDir, sessionId, (s) => {
    s.enabled = true;
    s.model = 'gpt-6-astra';
    s.expected = 'gpt-6-astra';
  });

  // Insert first degradation and observe on UserPromptSubmit
  insertTestLog(dbFile, {
    id: 501, ts: 1789640001, threadId: sessionId,
    body: `turn{thread.id=${sessionId} model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}`,
  });
  await handleHook({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }, dataDir, 1000);

  // Insert second degradation: Stop hook will trip hard circuit breaker
  insertTestLog(dbFile, {
    id: 502, ts: 1789640002, threadId: sessionId,
    body: `turn{thread.id=${sessionId} model=gpt-6-astra}: Request completed method=POST url=https://chatgpt.com/backend-api/codex/responses status=200 headers={"x-codex-safety-buffering-enabled": "true", "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"}`,
  });

  // Create mock codex executable that persists goal in a json file
  const goalStateFile = path.join(dir, 'mock-goal-state.json');
  await writeFile(goalStateFile, JSON.stringify({ status: 'active', calls: [] }));

  const mockServerJs = path.join(dir, 'mock-codex-bin.mjs');
  const serverCode = `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';

const stateFile = ${JSON.stringify(goalStateFile)};
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.calls.push(msg.method);

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'mock-codex' } }) + '\\n');
  } else if (msg.method === 'initialized') {
    // no reply needed
  } else if (msg.method === 'thread/goal/get') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { goal: { threadId: msg.params.threadId, status: state.status } } }) + '\\n');
  } else if (msg.method === 'thread/goal/set') {
    state.status = msg.params.status;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    process.stdout.write(JSON.stringify({ id: msg.id, result: { goal: { threadId: msg.params.threadId, status: state.status } } }) + '\\n');
  }
});
`;
  await writeFile(mockServerJs, serverCode, { mode: 0o755 });
  await chmod(mockServerJs, 0o755);

  const prevCodexPath = process.env.MODELTRACE_CODEX_PATH;
  process.env.MODELTRACE_CODEX_PATH = mockServerJs;
  t.after(() => {
    if (prevCodexPath) process.env.MODELTRACE_CODEX_PATH = prevCodexPath;
    else delete process.env.MODELTRACE_CODEX_PATH;
  });

  // Autonomous goal scheduler loop simulation with strict safety limits
  let turn = 1;
  const maxTurns = 5; // Request upper limit for safety
  const executedTurns = [];

  while (turn <= maxTurns) {
    const currentGoalState = JSON.parse(await readFile(goalStateFile, 'utf8'));
    if (currentGoalState.status !== 'active') {
      // Goal is paused, scheduler stops scheduling new turns!
      break;
    }
    executedTurns.push(turn);

    // Call production hook entry: node guard.mjs hook
    const hookInput = {
      session_id: sessionId,
      hook_event_name: 'Stop',
      turn_id: `turn-${turn}`,
    };
    const proc = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guard.mjs'), 'hook', '--data-dir', dataDir], {
      input: JSON.stringify(hookInput),
      env: { ...process.env, MODELTRACE_CODEX_PATH: mockServerJs },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(proc.status, 0, `Production hook must exit 0: ${proc.stderr}`);
    const hookOutput = JSON.parse(proc.stdout);

    if (turn === 1) {
      assert.equal(hookOutput.continue, false);
      assert.equal(hookOutput.decision, 'block');
      assert.ok(hookOutput.reason?.includes('(host active goal paused)'));
    }
    turn++;
  }

  // Verify scheduler stopped after turn 1 and did NOT loop up to maxTurns
  assert.deepEqual(executedTurns, [1], 'Autonomous goal scheduling must terminate after turn 1');
  const finalGoalState = JSON.parse(await readFile(goalStateFile, 'utf8'));
  assert.equal(finalGoalState.status, 'paused', 'Host goal status must be confirmed paused');
});

