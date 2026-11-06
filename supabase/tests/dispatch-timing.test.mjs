import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../../src/lib/dateUtils.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const { getServerDeadline } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

const SERVER_NOW = '2026-10-25T12:00:00.000Z';
const DUE_AT = '2026-10-25T12:01:30.000Z';
const SERVER_EPOCH = Date.parse(SERVER_NOW);

for (const skew of [-86_400_000, 86_400_000]) {
  test(`device clock skew of ${skew}ms does not change the server delay`, t => {
    const wallClock = t.mock.method(Date, 'now', () => SERVER_EPOCH + skew);
    t.mock.method(performance, 'now', () => 250.5);

    assert.equal(getServerDeadline(DUE_AT, SERVER_NOW), 90_250.5);
    assert.equal(wallClock.mock.callCount(), 0);
  });
}

test('uses the supplied receipt time without reading either device clock', t => {
  const wallClock = t.mock.method(Date, 'now', () => {
    throw new Error('Unexpected wall clock access');
  });
  const monotonicClock = t.mock.method(performance, 'now', () => {
    throw new Error('Unexpected receipt time access');
  });

  assert.equal(getServerDeadline(DUE_AT, SERVER_NOW, 12.5), 90_012.5);
  assert.equal(wallClock.mock.callCount(), 0);
  assert.equal(monotonicClock.mock.callCount(), 0);
});

test('large wall clock jumps during a countdown do not change its deadline', t => {
  let wallNow = SERVER_EPOCH;
  let monotonicNow = 1_000;
  const wallClock = t.mock.method(Date, 'now', () => wallNow);
  t.mock.method(performance, 'now', () => monotonicNow);
  const deadline = getServerDeadline(DUE_AT, SERVER_NOW);

  for (const [elapsed, jump] of [[1_000, 315_360_000_000], [30_000, -315_360_000_000], [90_000, 0]]) {
    wallNow = SERVER_EPOCH + elapsed + jump;
    monotonicNow = 1_000 + elapsed;
    const serverNow = new Date(SERVER_EPOCH + elapsed).toISOString();

    assert.equal(deadline - performance.now(), 90_000 - elapsed);
    assert.equal(getServerDeadline(DUE_AT, serverNow), deadline);
  }
  assert.equal(wallClock.mock.callCount(), 0);
});

test('server UTC offsets describe the same remaining duration', () => {
  for (const [dueAt, serverNow] of [
    [DUE_AT, SERVER_NOW],
    ['2026-10-25T20:01:30+08:00', SERVER_NOW],
    [DUE_AT, '2026-10-25T05:00:00-07:00'],
    ['2026-10-25T20:01:30+08:00', '2026-10-25T05:00:00-07:00'],
    ['2026-10-25T17:31:30+05:30', '2026-10-25T17:30:00+05:30'],
  ]) {
    assert.equal(getServerDeadline(dueAt, serverNow, 500), 90_500);
  }
});

for (const seconds of [1, 30, 47.125, 60, 90, 120, 150, 3000]) {
  test(`preserves an arbitrary server interval of ${seconds} seconds`, () => {
    const dueAt = new Date(SERVER_EPOCH + seconds * 1_000).toISOString();

    assert.equal(getServerDeadline(dueAt, SERVER_NOW, 250), 250 + seconds * 1_000);
  });
}

test('rereading a scheduled dispatch uses only its remaining server time', () => {
  const dueAt = '2026-10-25T12:02:30.000Z';
  const initialDeadline = getServerDeadline(dueAt, SERVER_NOW, 1_000);
  const rereadServerNow = '2026-10-25T12:01:40.000Z';
  const rereadDeadline = getServerDeadline(dueAt, rereadServerNow, 101_000);

  assert.equal(initialDeadline, 151_000);
  assert.equal(rereadDeadline, initialDeadline);
  assert.equal(rereadDeadline - 101_000, 50_000);
  assert.equal(getServerDeadline(dueAt, rereadServerNow, 25), 50_025);
});

test('expired and exactly due dispatches are immediately due', () => {
  for (const dueAt of ['2026-10-25T11:59:59.999Z', '2026-10-24T12:00:00.000Z', SERVER_NOW]) {
    assert.equal(getServerDeadline(dueAt, SERVER_NOW, 500.25), 500.25);
  }
});

test('rejects invalid due times and invalid server times', () => {
  const error = { name: 'Error', message: 'The dispatch server returned an invalid due time.' };
  for (const invalid of ['', 'not-a-date', '2026-99-99T00:00:00Z', 'Infinity', 'NaN', '+999999-01-01T00:00:00Z']) {
    assert.throws(() => getServerDeadline(invalid, SERVER_NOW, 500), error);
    assert.throws(() => getServerDeadline(DUE_AT, invalid, 500), error);
  }
  assert.throws(() => getServerDeadline('invalid', 'invalid', 500), error);
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import ts from 'typescript';

const dispatchSource = readFileSync(new URL('../../src/components/employee/OrderDispatch.tsx', import.meta.url), 'utf8');
const supabaseSource = readFileSync(new URL('../../src/lib/supabase.ts', import.meta.url), 'utf8');

function extractDispatchDeclarations(text, names) {
  const source = ts.createSourceFile('dispatch-behavior.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  function visit(node) {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) {
      const name = node.name.getText(source);
      if (names.includes(name)) {
        assert.equal(declarations.has(name), false, `Duplicate declaration: ${name}`);
        declarations.set(name, ts.isVariableDeclaration(node)
          ? `const ${name} = ${node.initializer.getText(source)};`
          : node.getText(source).replace(/^export\s+/, ''));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names.map(name => {
    assert.ok(declarations.has(name), `Missing source declaration: ${name}`);
    return declarations.get(name);
  }).join('\n');
}

const recoveryConstantNames = ['DISPATCH_RECOVERY_DELAYS_MS', 'DISPATCH_RECOVERY_NOTICE_MS'];
const { code: recoveryConstantsCode } = await transform(extractDispatchDeclarations(dispatchSource, recoveryConstantNames), {
  loader: 'ts', target: 'es2022',
});
const productionRecoverySettings = runInNewContext(`${recoveryConstantsCode}\n({
  delays: DISPATCH_RECOVERY_DELAYS_MS, noticeMs: DISPATCH_RECOVERY_NOTICE_MS,
});`);

const { code: dispatchBehaviorCode } = await transform([
  extractDispatchDeclarations(supabaseSource, [
    'stringifySupabaseErrorValue', 'formatSupabaseError', 'isSupabaseTransientError',
  ]),
  extractDispatchDeclarations(dispatchSource, [
    'DISPATCH_SESSION_STORAGE_KEY', 'PAUSED_DISPATCH_CHECK_MS', 'getOrderDispatchErrorMessage', 'isInvalidDispatchSession', 'logDispatchError',
    'isCurrentDispatch', 'clearDispatchTimer', 'stopHeartbeat', 'stopLocalWorkingState',
    'recoverDispatchState', 'restartSessionAfterLifecycleGap', 'handleInvalidDispatchSession',
    'handleVisibilityChange', 'reconcileUncertainFinish', 'handleCompleteOrder', 'handleSubmitError',
    'sendHeartbeat', 'handleStopWork', 'pauseDispatch', 'armDispatchTimer', 'scheduleNextOrder', 'dispatchNewOrder',
  ]),
  `restartSessionRef.current = restartSessionAfterLifecycleGap;
   globalThis.dispatchBehavior = {
     restart: restartSessionAfterLifecycleGap, recover: recoverDispatchState, heartbeat: sendHeartbeat,
     stop: handleStopWork, schedule: scheduleNextOrder, assign: dispatchNewOrder,
     handleVisibilityChange, handleCompleteOrder, handleSubmitError,
     storageKey: DISPATCH_SESSION_STORAGE_KEY,
   };`,
].join('\n'), { loader: 'ts', target: 'es2022' });

function dispatchDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushDispatchMicrotasks() {
  // 包含 vm/宿主 Promise 的交接，以及 finally 中启动的下一轮准备请求。
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}

function dispatchFakeClock() {
  let now = 1_000;
  let nextId = 1;
  const pending = new Map();
  const created = [];
  const add = (callback, delay, interval = false) => {
    const timer = { id: nextId++, callback, delay, at: now + delay, interval };
    pending.set(timer.id, timer);
    created.push(timer);
    return timer.id;
  };
  return {
    now: () => now,
    pending, created,
    setTimeout: (callback, delay = 0) => add(callback, delay),
    setInterval: (callback, delay) => add(callback, delay, true),
    clear: id => pending.delete(id),
    async advance(ms) {
      const target = now + ms;
      await flushDispatchMicrotasks();
      for (let turns = 0; ; turns += 1) {
        assert.ok(turns < 100, 'Unexpected timer loop');
        const next = [...pending.values()].filter(timer => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        now = next.at;
        pending.delete(next.id);
        if (next.interval) pending.set(next.id, { ...next, at: now + next.delay });
        next.callback();
        await flushDispatchMicrotasks();
      }
      now = target;
      await flushDispatchMicrotasks();
    },
  };
}

const RECOVER_DISPATCH_RPC = 'recover_employee_dispatch_guarded';
const PREPARE_DISPATCH_RPC = 'prepare_next_dispatch_order_secure';
const ASSIGN_DISPATCH_RPC = 'assign_next_dispatch_order_secure';
const HEARTBEAT_DISPATCH_RPC = 'update_session_heartbeat_secure';
const END_DISPATCH_RPC = 'end_employee_dispatch_session_secure';
const dispatchNetworkError = () => ({ name: 'SupabaseNetworkError', message: 'Failed to fetch' });
const recoveredDispatch = (assignment = null) => ({ data: {
  success: true, recovered: true, session_id: 'dispatch-session', started_at: SERVER_NOW,
  unaccepted_count: 2, assignment,
}, error: null });
const preparedDispatch = () => ({ data: {
  available: true, group_id: 'dispatch-group', pool_id: 'dispatch-pool', due_at: DUE_AT, server_now: SERVER_NOW,
}, error: null });
const dispatchAssignment = status => ({
  id: 'existing-assignment', status, dispatch_session_id: 'dispatch-session',
  assigned_at: SERVER_NOW, session_timeout_minutes: 15,
  dispatch_orders: { order_content: 'Local test order' },
});

function dispatchRecoveryHarness(options = {}) {
  const clock = dispatchFakeClock();
  const calls = [];
  const events = [];
  const state = {};
  const storage = new Map();
  const operationIds = [];
  const ref = current => ({ current });
  const context = {
    sessionStorage: {
      getItem: key => storage.get(String(key)) ?? null,
      setItem: (key, value) => storage.set(String(key), String(value)),
      removeItem: key => storage.delete(String(key)),
    },
    crypto: { randomUUID: () => {
      const id = `00000000-0000-4000-8000-${String(operationIds.length + 1).padStart(12, '0')}`;
      operationIds.push(id);
      return id;
    } },
    DISPATCH_RECOVERY_DELAYS_MS: options.delays ?? [0, 1, 2],
    DISPATCH_RECOVERY_NOTICE_MS: options.noticeMs ?? 1,
    document: { hidden: false }, performance: { now: clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clear,
    setInterval: clock.setInterval, clearInterval: clock.clear,
    requestAnimationFrame: callback => { callback(clock.now()); return 0; },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => events.push([level, ...args])])),
    componentMountedRef: ref(true), lifecycleGenerationRef: ref(0),
    sessionIdRef: ref('dispatch-session'), sessionActiveRef: ref(true),
    startWorkLockRef: ref(false), recoveryAfterStartRef: ref(null),
    stoppingSessionRef: ref(false), deferredVisibilityRecoveryRef: ref(false), finishingDispatchRef: ref(null),
    visibilityRestartPromiseRef: ref(null), recoveryInFlightRef: ref(null),
    dispatchRecoveryFailuresRef: ref({ count: 0, lastAttemptAt: 0 }),
    preparingDispatchRef: ref(null), assigningDispatchRef: ref(null),
    dispatchTimerRef: ref(null), selectedDispatchRef: ref(null), dispatchPausedRef: ref(false),
    currentOrderRef: ref(null), unacceptedCountRef: ref(0), lastActivityRef: ref(null),
    heartbeatTimerRef: ref('existing-heartbeat'), grabFailedTimerRef: ref(null), activityTimerRef: ref(null),
    acceptTimeoutRef: ref(null), processTimeoutRef: ref(null), fiveMinuteWarningRef: ref(null), timeoutCheckRef: ref(null),
    membershipRevisionRef: ref(0), membershipChangeDuringAssignmentRef: ref(false), dispatchHoldUntilRef: ref(0),
    restartSessionRef: ref(null), startTimeoutCheckRef: ref(() => events.push(['timeout-check'])),
    pageHiddenAtRef: ref(null), isMobileRef: ref(false),
    refreshDispatchTimingRef: ref(() => events.push(['refresh-dispatch-timing'])),
    sendHeartbeatRef: ref(async () => events.push(['heartbeat'])),
    isCompleting: false, isReporting: false, errorReason: '',
    handleAcceptTimeoutRef: ref(null), checkPendingOrderRef: ref(null),
    panelVeilTimerRef: ref(null), panelRef: ref(null), panelResizeAnimationRef: ref(null),
    isProcessing: false, currentOrder: null,
    session: { isWorking: true, sessionId: 'dispatch-session', startedAt: new Date(SERVER_NOW) },
    dispatchPause: null, t: { dispatch: {} },
    getStoredAuth: () => ({
      userType: 'employee', user: { id: 'local-employee' }, financialSessionToken: 'local-token', tabId: 'local-tab',
    }),
    getServerDeadline,
    startHeartbeat: () => { events.push(['start-heartbeat']); context.heartbeatTimerRef.current = 'new-heartbeat'; },
    loadTotalWorkTime: async () => events.push(['load-work-time']),
    loadTodayOrders: async () => events.push(['load-orders']),
    updateActivity: () => events.push(['activity']),
    playOrderNotificationSound: () => events.push(['order-sound']),
    onStatusChange: (...args) => events.push(['status', ...args]),
    onSessionExpired: () => events.push(['session-expired']),
    showNotification: notice => events.push(['notification', notice]),
    dispatchErrorText: error => error?.message || String(error),
  };
  const setters = [
    'setCurrentOrder', 'setShowOrderDetail', 'setShowDispatchRecovery', 'setSession', 'setUnacceptedCount',
    'setHasScheduledDispatch', 'setDispatchPause', 'setHasTimeout', 'setHasFiveMinuteWarning', 'setShowTimeoutAlert',
    'setShowGrabFailedModal', 'setAutoStopReason', 'setShowAutoStopModal', 'setShowErrorModal', 'setErrorReason',
    'setIsCompleting', 'setIsReporting',
    'setIsTransitioning', 'setTransitionType', 'setIsProcessing', 'setShowTimeoutStopModal',
    'setPanelVeilKey', 'setStartConnect', 'setWaitingEnterAnim', 'setStopExiting', 'setPanelVeilKind', 'setPanelVeil',
  ];
  for (const name of setters) {
    context[name] = value => {
      state[name] = typeof value === 'function' ? value(state[name] ?? 0) : value;
      events.push([name, state[name]]);
      if (name === 'setSession') context.session = state[name];
      if (name === 'setCurrentOrder') context.currentOrder = state[name];
      if (name === 'setDispatchPause') context.dispatchPause = state[name];
    };
  }
  context.setIsPageVisible = value => events.push(['setIsPageVisible', value]);
  context.setSuppressAnimations = () => {};
  context.supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args, at: clock.now(), generation: context.lifecycleGenerationRef.current,
        restarting: Boolean(context.visibilityRestartPromiseRef.current), recovering: Boolean(context.recoveryInFlightRef.current) });
      if (options.rpc) return options.rpc(name, args, calls);
      if (name === RECOVER_DISPATCH_RPC) return recoveredDispatch();
      if (name === PREPARE_DISPATCH_RPC) return preparedDispatch();
      if (name === END_DISPATCH_RPC || name === HEARTBEAT_DISPATCH_RPC) return { data: { success: true }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
    from: () => { throw new Error('Unexpected database query'); },
  };
  runInNewContext(dispatchBehaviorCode, context, { timeout: 1_000 });
  context.sessionStorage.setItem(context.dispatchBehavior.storageKey, JSON.stringify({
    userId: 'local-employee', tabId: 'local-tab', sessionId: 'dispatch-session',
  }));
  return {
    api: context.dispatchBehavior, context, state, events, calls, clock, operationIds,
    storedSession: () => JSON.parse(context.sessionStorage.getItem(context.dispatchBehavior.storageKey)),
    rpcCalls: name => calls.filter(call => call.name === name),
    pauses: () => events.filter(([name, value]) => name === 'setDispatchPause' && value !== null),
    notices: () => events.filter(([name, value]) => name === 'setShowDispatchRecovery' && value === true),
  };
}

test('dispatch recovery uses three production attempts at [0, 2000, 5000] and a 2s panel notice', async () => {
  assert.deepEqual(Array.from(productionRecoverySettings.delays), [0, 2000, 5000]);
  assert.equal(productionRecoverySettings.noticeMs, 2_000);
  const h = dispatchRecoveryHarness({
    delays: Array.from(productionRecoverySettings.delays), noticeMs: productionRecoverySettings.noticeMs,
    rpc: async () => ({ data: null, error: dispatchNetworkError() }),
  });
  const operation = h.api.restart();
  await h.clock.advance(1_999);
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 1);
  assert.equal(h.notices().length, 0);
  assert.equal(h.pauses().length, 0);
  await h.clock.advance(1);
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 2);
  assert.equal(h.notices().length, 1);
  assert.equal(h.pauses().length, 0, 'A slow reconciliation only changes the panel, not the pause state');
  await h.clock.advance(4_999);
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 2);
  await h.clock.advance(1);
  await operation;
  assert.deepEqual(h.rpcCalls(RECOVER_DISPATCH_RPC).map(call => call.at - 1_000), [0, 2_000, 7_000]);
  assert.equal(h.pauses().length, 1);
  assert.equal(h.state.setShowDispatchRecovery, false);
  assert.equal(h.context.visibilityRestartPromiseRef.current, null);
  assert.equal(h.context.recoveryInFlightRef.current, null);
  assert.deepEqual(h.calls.map(call => call.name), Array(3).fill(RECOVER_DISPATCH_RPC));
  assert.deepEqual([...h.clock.pending.values()].map(timer => timer.delay), [300_000]);
});

test('transient recovery failures retry reconciliation only, then automatically schedule without pausing', async () => {
  let attempts = 0;
  const h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === RECOVER_DISPATCH_RPC) {
      attempts += 1;
      if (attempts === 1) return { data: null, error: dispatchNetworkError() };
      if (attempts === 2) throw { name: 'SupabaseTimeoutError', message: 'Request timed out' };
      return recoveredDispatch();
    }
    assert.equal(name, PREPARE_DISPATCH_RPC);
    return preparedDispatch();
  } });
  const operation = h.api.restart();
  await h.clock.advance(3);
  await operation;
  assert.deepEqual(h.calls.map(call => call.name), [RECOVER_DISPATCH_RPC, RECOVER_DISPATCH_RPC, RECOVER_DISPATCH_RPC, PREPARE_DISPATCH_RPC]);
  assert.deepEqual(h.rpcCalls(RECOVER_DISPATCH_RPC).map(call => call.at - 1_000), [0, 1, 3]);
  assert.equal(h.pauses().length, 0);
  assert.equal(h.notices().length, 1);
  assert.equal(h.state.setShowDispatchRecovery, false);
  assert.equal(h.state.setHasScheduledDispatch, true);
  assert.equal(h.context.dispatchPausedRef.current, false);
  assert.equal(h.context.visibilityRestartPromiseRef.current, null);
  assert.equal(h.context.recoveryInFlightRef.current, null);
  const preparation = h.rpcCalls(PREPARE_DISPATCH_RPC)[0];
  assert.equal(preparation.restarting, false, 'finally must release the restart lock before scheduling');
  assert.equal(preparation.recovering, false);
  assert.equal(h.events.filter(([name]) => name === 'heartbeat').length, 1);
  assert.equal(h.rpcCalls(ASSIGN_DISPATCH_RPC).length, 0);
  assert.equal(h.operationIds.length, 1);
  for (const call of h.rpcCalls(RECOVER_DISPATCH_RPC)) {
    assert.deepEqual({ ...call.args }, {
      p_user_id: 'local-employee', p_session_token: 'local-token', p_tab_id: 'local-tab',
      p_expected_session_id: 'dispatch-session', p_operation_id: h.operationIds[0],
    });
  }
  assert.deepEqual(h.storedSession(), {
    userId: 'local-employee', tabId: 'local-tab', sessionId: 'dispatch-session',
  });
});

test('each recovery workflow reuses its operation UUID for every retry and creates a new UUID for the next session', async () => {
  let attempts = 0;
  const h = dispatchRecoveryHarness({ rpc: async (name, args) => {
    assert.equal(name, RECOVER_DISPATCH_RPC);
    attempts += 1;
    if (attempts % 3 !== 0) return { data: null, error: dispatchNetworkError() };
    const assignment = dispatchAssignment('pending');
    assignment.dispatch_session_id = args.p_expected_session_id;
    const result = recoveredDispatch(assignment);
    result.data.session_id = args.p_expected_session_id;
    return result;
  } });

  const first = h.api.restart();
  await h.clock.advance(3);
  await first;
  h.context.sessionIdRef.current = 'next-dispatch-session';
  const second = h.api.restart();
  await h.clock.advance(3);
  await second;

  const calls = h.rpcCalls(RECOVER_DISPATCH_RPC);
  assert.equal(calls.length, 6);
  assert.equal(h.operationIds.length, 2);
  assert.match(h.operationIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(h.operationIds[0], h.operationIds[1]);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual({ ...call.args }, {
      p_user_id: 'local-employee', p_session_token: 'local-token', p_tab_id: 'local-tab',
      p_expected_session_id: index < 3 ? 'dispatch-session' : 'next-dispatch-session',
      p_operation_id: h.operationIds[index < 3 ? 0 : 1],
    });
  }
  assert.deepEqual(h.storedSession(), {
    userId: 'local-employee', tabId: 'local-tab', sessionId: 'next-dispatch-session',
  });
});

test('standalone recovery forwards a null expected session and an explicitly supplied operation UUID', async () => {
  const h = dispatchRecoveryHarness({ rpc: async () => recoveredDispatch(dispatchAssignment('pending')) });
  h.context.sessionIdRef.current = null;
  h.context.sessionStorage.removeItem(h.api.storageKey);
  const operationId = '11111111-1111-4111-8111-111111111111';
  const result = await h.api.recover(null, 0, operationId);
  assert.equal(result.state, 'active');
  assert.deepEqual({ ...h.rpcCalls(RECOVER_DISPATCH_RPC)[0].args }, {
    p_user_id: 'local-employee', p_session_token: 'local-token', p_tab_id: 'local-tab',
    p_expected_session_id: null, p_operation_id: operationId,
  });
  assert.equal(h.operationIds.length, 0);
  assert.deepEqual(h.storedSession(), {
    userId: 'local-employee', tabId: 'local-tab', sessionId: 'dispatch-session',
  });
});

test('independent standalone recoveries generate fresh operation UUIDs by default', async () => {
  const h = dispatchRecoveryHarness({ rpc: async () => recoveredDispatch(dispatchAssignment('pending')) });
  await h.api.recover('dispatch-session', 0);
  await h.api.recover('dispatch-session', 0);
  assert.equal(h.operationIds.length, 2);
  assert.notEqual(h.operationIds[0], h.operationIds[1]);
  assert.deepEqual(h.rpcCalls(RECOVER_DISPATCH_RPC).map(call => ({ ...call.args })), h.operationIds.map(id => ({
    p_user_id: 'local-employee', p_session_token: 'local-token', p_tab_id: 'local-tab',
    p_expected_session_id: 'dispatch-session', p_operation_id: id,
  })));
});

test('fast recovery clears the notice timer before displaying a recovery panel', async () => {
  const h = dispatchRecoveryHarness();
  await h.api.restart();
  await h.clock.advance(1);
  assert.equal(h.notices().length, 0);
  assert.equal(h.pauses().length, 0);
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC).length, 1);
  assert.equal(h.state.setHasScheduledDispatch, true);
});

test('a non-transient recovery failure pauses once without retrying or restarting work', async () => {
  const h = dispatchRecoveryHarness({ rpc: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) });
  await h.api.restart();
  await h.clock.advance(10);
  assert.deepEqual(h.calls.map(call => call.name), [RECOVER_DISPATCH_RPC]);
  assert.equal(h.pauses().length, 1);
  assert.equal(h.context.dispatchPausedRef.current, true);
  assert.equal(h.state.setShowDispatchRecovery, false);
});

for (const status of ['pending', 'accepted']) {
  test(`recovery restores an existing ${status} assignment without scheduling another order`, async () => {
    const assignment = dispatchAssignment(status);
    const h = dispatchRecoveryHarness({ rpc: async () => recoveredDispatch(assignment) });
    h.context.dispatchRecoveryFailuresRef.current.count = 2;
    await h.api.restart(dispatchNetworkError());
    assert.deepEqual(h.calls.map(call => call.name), [RECOVER_DISPATCH_RPC]);
    assert.equal(h.context.currentOrderRef.current, assignment);
    assert.equal(h.state.setCurrentOrder, assignment);
    assert.equal(h.state.setShowOrderDetail, true);
    assert.equal(h.context.dispatchRecoveryFailuresRef.current.count, 0);
    assert.equal(h.pauses().length, 0);
    assert.equal(h.context.visibilityRestartPromiseRef.current, null);
    assert.equal(h.context.recoveryInFlightRef.current, null);
    assert.equal(h.clock.pending.size, 0);
  });
}

test('confirmed recovered=false stops locally and never schedules or starts a new work session', async () => {
  const h = dispatchRecoveryHarness({ rpc: async () => ({ data: { success: true, recovered: false }, error: null }) });
  h.context.currentOrderRef.current = dispatchAssignment('pending');
  await h.api.restart();
  await h.clock.advance(10);
  assert.deepEqual(h.calls.map(call => call.name), [RECOVER_DISPATCH_RPC]);
  assert.equal(h.context.sessionActiveRef.current, false);
  assert.equal(h.context.sessionIdRef.current, null);
  assert.equal(h.context.currentOrderRef.current, null);
  assert.equal(h.state.setSession.isWorking, false);
  assert.equal(h.state.setAutoStopReason, 'ended');
  assert.equal(h.state.setShowAutoStopModal, true);
  assert.equal(h.context.heartbeatTimerRef.current, null);
  assert.equal(h.storedSession(), null);
  assert.equal(h.pauses().length, 0);
  assert.equal(h.events.filter(([name]) => name === 'heartbeat' || name === 'start-heartbeat').length, 0);
  assert.equal(h.clock.pending.size, 0);
});

test('concurrent lifecycle recoveries share the exact promise and a single reconciliation', async () => {
  const response = dispatchDeferred();
  const h = dispatchRecoveryHarness({ rpc: async name => name === RECOVER_DISPATCH_RPC ? response.promise : preparedDispatch() });
  const first = h.api.restart(dispatchNetworkError());
  const generation = h.context.lifecycleGenerationRef.current;
  assert.equal(h.api.restart(dispatchNetworkError()), first);
  assert.equal(h.api.restart(), first);
  assert.equal(h.context.dispatchRecoveryFailuresRef.current.count, 1);
  await flushDispatchMicrotasks();
  assert.equal(h.api.restart(), first);
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 1);
  assert.equal(h.context.lifecycleGenerationRef.current, generation);
  response.resolve(recoveredDispatch());
  await first;
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC).length, 1);
  assert.equal(h.pauses().length, 0);
  assert.equal(h.context.visibilityRestartPromiseRef.current, null);
});

test('recovery waits for both old prepare and assign settled promises before reconciling', async () => {
  const preparation = dispatchDeferred();
  const assignment = dispatchDeferred();
  const order = dispatchAssignment('pending');
  const h = dispatchRecoveryHarness({ rpc: async () => recoveredDispatch(order) });
  h.context.preparingDispatchRef.current = { sessionId: 'dispatch-session', generation: 0, settled: preparation.promise };
  h.context.assigningDispatchRef.current = { sessionId: 'dispatch-session', generation: 0, settled: assignment.promise };
  const operation = h.api.restart();
  await h.clock.advance(1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices().length, 1);
  assert.equal(h.pauses().length, 0);
  preparation.resolve();
  await flushDispatchMicrotasks();
  assert.equal(h.calls.length, 0, 'The old assign request is still unresolved');
  assignment.resolve();
  await operation;
  assert.deepEqual(h.calls.map(call => call.name), [RECOVER_DISPATCH_RPC]);
  assert.equal(h.context.currentOrderRef.current, order);
});

test('a lost assign response is reconciled after the real assign finally, never replayed', async () => {
  const response = dispatchDeferred();
  const order = dispatchAssignment('pending');
  let h;
  h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === ASSIGN_DISPATCH_RPC) return response.promise;
    assert.equal(name, RECOVER_DISPATCH_RPC);
    assert.equal(h.context.assigningDispatchRef.current, null, 'Assignment finally must have settled and cleared the old request');
    return recoveredDispatch(order);
  } });
  const selection = { sessionId: 'dispatch-session', groupId: 'dispatch-group', poolId: 'dispatch-pool', deadline: 1_000 };
  h.context.selectedDispatchRef.current = selection;
  const assignment = h.api.assign(selection, 0);
  const settled = h.context.assigningDispatchRef.current.settled;
  const operation = h.api.restart();
  await flushDispatchMicrotasks();
  assert.deepEqual(h.calls.map(call => call.name), [ASSIGN_DISPATCH_RPC]);
  response.reject(dispatchNetworkError());
  await assignment;
  await settled;
  await operation;
  assert.deepEqual(h.calls.map(call => call.name), [ASSIGN_DISPATCH_RPC, RECOVER_DISPATCH_RPC]);
  assert.equal(h.context.currentOrderRef.current, order);
  assert.equal(h.pauses().length, 0);
});

test('standalone idle reconciliation schedules only after releasing recoveryInFlight', async () => {
  const h = dispatchRecoveryHarness();
  const result = await h.api.recover('dispatch-session', 0);
  await flushDispatchMicrotasks();
  assert.equal(result.state, 'idle');
  assert.deepEqual(h.calls.map(call => call.name), [RECOVER_DISPATCH_RPC, PREPARE_DISPATCH_RPC]);
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC)[0].recovering, false);
  assert.equal(h.state.setHasScheduledDispatch, true);
});

for (const lateResult of ['success', 'network failure']) {
  test(`explicit Stop invalidates generation and ignores a late recovery ${lateResult}`, async () => {
    const response = dispatchDeferred();
    const h = dispatchRecoveryHarness({ rpc: async name => {
      if (name === RECOVER_DISPATCH_RPC) return response.promise;
      assert.equal(name, END_DISPATCH_RPC);
      assert.equal(h.storedSession().sessionId, 'dispatch-session', 'A stale recovery must not replace stored state');
      return { data: { success: true }, error: null };
    } });
    const operation = h.api.restart();
    await flushDispatchMicrotasks();
    const generation = h.context.lifecycleGenerationRef.current;
    const stop = h.api.stop();
    assert.equal(h.context.stoppingSessionRef.current, true);
    assert.equal(h.context.lifecycleGenerationRef.current, generation + 1);
    assert.equal(h.storedSession().sessionId, 'dispatch-session');
    if (lateResult === 'success') {
      const stale = recoveredDispatch(dispatchAssignment('pending'));
      stale.data.session_id = 'stale-replacement-session';
      response.resolve(stale);
    } else response.reject(dispatchNetworkError());
    await h.clock.advance(500);
    await operation;
    await stop;
    assert.deepEqual(h.calls.map(call => call.name), [RECOVER_DISPATCH_RPC, END_DISPATCH_RPC]);
    assert.equal(h.rpcCalls(END_DISPATCH_RPC)[0].args.p_session_id, null);
    assert.equal(h.context.sessionActiveRef.current, false);
    assert.equal(h.context.sessionIdRef.current, null);
    assert.equal(h.storedSession(), null);
    assert.equal(h.state.setSession.isWorking, false);
    assert.equal(h.context.currentOrderRef.current, null);
    assert.equal(h.events.filter(([name, value]) => name === 'setSession' && value.isWorking).length, 0);
    assert.equal(h.events.filter(([name]) => name === 'heartbeat' || name === 'start-heartbeat').length, 0);
    assert.equal(h.pauses().length, 0);
    assert.equal(h.context.stoppingSessionRef.current, false);
    assert.equal(h.context.recoveryInFlightRef.current, null);
    assert.equal(h.context.visibilityRestartPromiseRef.current, null);
  });
}

test('the stopping lock blocks recovery and new preparation even while the stop RPC is pending', async () => {
  const response = dispatchDeferred();
  const h = dispatchRecoveryHarness({ rpc: async name => {
    assert.equal(name, END_DISPATCH_RPC);
    return response.promise;
  } });
  const stop = h.api.stop(true);
  assert.equal(h.context.stoppingSessionRef.current, true);
  const generation = h.context.lifecycleGenerationRef.current;
  await h.api.restart(dispatchNetworkError());
  await h.api.restart();
  await h.api.schedule();
  assert.equal(h.context.lifecycleGenerationRef.current, generation);
  assert.equal(h.context.dispatchRecoveryFailuresRef.current.count, 0);
  assert.deepEqual(h.calls.map(call => call.name), [END_DISPATCH_RPC]);
  assert.equal(h.clock.created.length, 0);
  response.resolve({ data: { success: true }, error: null });
  await stop;
  assert.equal(h.context.stoppingSessionRef.current, false);
});

for (const lateReply of ['rejected heartbeat', 'invalid-session error', 'thrown invalid-session error']) {
  test(`heartbeat generation guard ignores a ${lateReply} from an older lifecycle`, async () => {
    const response = dispatchDeferred();
    const h = dispatchRecoveryHarness({ rpc: async name => {
      assert.equal(name, HEARTBEAT_DISPATCH_RPC);
      return response.promise;
    } });
    const heartbeat = h.api.heartbeat();
    // 同一 sessionId 仍在工作，只有 generation 改变；仅核对 sessionId 无法通过此测试。
    h.context.lifecycleGenerationRef.current += 1;
    const invalid = { message: 'Employee work session is invalid, offline, or stale.' };
    if (lateReply === 'rejected heartbeat') response.resolve({ data: { success: false, reason: 'stale' }, error: null });
    else if (lateReply === 'invalid-session error') response.resolve({ data: null, error: invalid });
    else response.reject(invalid);
    await heartbeat;
    assert.deepEqual(h.calls.map(call => call.name), [HEARTBEAT_DISPATCH_RPC]);
    assert.equal(h.context.sessionActiveRef.current, true);
    assert.equal(h.context.sessionIdRef.current, 'dispatch-session');
    assert.equal(h.context.visibilityRestartPromiseRef.current, null);
    assert.equal(h.events.length, 0, 'Stale heartbeats must not log errors, recover, stop, or change UI state');
  });
}

test('a current rejected heartbeat does reconcile, while another heartbeat is suppressed during recovery', async () => {
  const response = dispatchDeferred();
  const h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === HEARTBEAT_DISPATCH_RPC) return { data: { success: false, reason: 'stale' }, error: null };
    assert.equal(name, RECOVER_DISPATCH_RPC);
    return response.promise;
  } });
  const heartbeat = h.api.heartbeat();
  await flushDispatchMicrotasks();
  await h.api.heartbeat();
  assert.deepEqual(h.calls.map(call => call.name), [HEARTBEAT_DISPATCH_RPC, RECOVER_DISPATCH_RPC]);
  response.resolve(recoveredDispatch(dispatchAssignment('accepted')));
  await heartbeat;
  assert.equal(h.context.currentOrderRef.current.status, 'accepted');
  assert.equal(h.pauses().length, 0);
});

test('a simulated replacement recovery response updates session storage and continues scheduling', async () => {
  const h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === RECOVER_DISPATCH_RPC) {
      const result = recoveredDispatch();
      result.data.session_id = 'replacement-session';
      return result;
    }
    assert.equal(name, PREPARE_DISPATCH_RPC);
    return preparedDispatch();
  } });
  await h.api.restart();
  await flushDispatchMicrotasks();
  assert.equal(h.context.sessionIdRef.current, 'replacement-session');
  assert.deepEqual(h.storedSession(), {
    userId: 'local-employee', tabId: 'local-tab', sessionId: 'replacement-session',
  });
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC)[0].args.p_expected_session_id, 'dispatch-session');
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC)[0].args.p_session_id, 'replacement-session');
  assert.equal(h.pauses().length, 0);
});

test('recovery during the Start transition is deferred without invalidating that Start', async () => {
  const h = dispatchRecoveryHarness();
  h.context.startWorkLockRef.current = true;
  const error = dispatchNetworkError();
  await h.api.restart(error);
  assert.equal(h.context.lifecycleGenerationRef.current, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.recoveryAfterStartRef.current.failedRequest, error);
  h.context.startWorkLockRef.current = false;
  const pending = h.context.recoveryAfterStartRef.current;
  h.context.recoveryAfterStartRef.current = null;
  await h.api.restart(pending.failedRequest);
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 1);
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC).length, 1);
  assert.equal(h.context.sessionActiveRef.current, true);
  assert.equal(h.pauses().length, 0);
});

test('a failed Stop releases its lock before resuming an idle dispatch', async () => {
  const h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === END_DISPATCH_RPC) return { data: null, error: dispatchNetworkError() };
    assert.equal(name, PREPARE_DISPATCH_RPC);
    return preparedDispatch();
  } });
  await assert.rejects(h.api.stop(true));
  await flushDispatchMicrotasks();
  assert.equal(h.context.stoppingSessionRef.current, false);
  assert.equal(h.context.sessionActiveRef.current, true);
  assert.equal(h.storedSession().sessionId, 'dispatch-session');
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC).length, 1);
  assert.equal(h.state.setHasScheduledDispatch, true);
});

test('a short hide during recovery retries does not lose the next dispatch', async () => {
  let recoveries = 0;
  const h = dispatchRecoveryHarness({ delays: [0, 2, 5], noticeMs: 20, rpc: async name => {
    if (name === RECOVER_DISPATCH_RPC) {
      recoveries += 1;
      return recoveries === 1 ? { data: null, error: dispatchNetworkError() } : recoveredDispatch();
    }
    assert.equal(name, PREPARE_DISPATCH_RPC);
    return preparedDispatch();
  } });
  const E = h.api.handleVisibilityChange;
  const recovery = h.api.restart();
  await flushDispatchMicrotasks();
  h.context.document.hidden = true;
  E();
  await h.clock.advance(2);
  await recovery;
  assert.equal(h.context.deferredVisibilityRecoveryRef.current, true);
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 1);
  h.context.document.hidden = false;
  E();
  await h.context.visibilityRestartPromiseRef.current;
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 2);
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC).length, 1);
  assert.equal(h.rpcCalls(ASSIGN_DISPATCH_RPC).length, 0);
  assert.equal(h.context.sessionActiveRef.current, true);
  assert.equal(h.context.deferredVisibilityRecoveryRef.current, false);
  assert.equal(h.context.visibilityRestartPromiseRef.current, null);
});

test('explicit Stop discards a deferred visibility recovery after the page returns', async () => {
  let recoveries = 0;
  const h = dispatchRecoveryHarness({ delays: [0, 2], rpc: async name => {
    if (name === RECOVER_DISPATCH_RPC) {
      recoveries += 1;
      return recoveries === 1 ? { data: null, error: dispatchNetworkError() } : recoveredDispatch();
    }
    assert.equal(name, END_DISPATCH_RPC);
    return { data: { success: true }, error: null };
  } });
  const recovery = h.api.restart();
  await flushDispatchMicrotasks();
  h.context.document.hidden = true;
  h.api.handleVisibilityChange();
  const stop = h.api.stop(true);
  await h.clock.advance(2);
  await recovery;
  await stop;
  h.context.document.hidden = false;
  h.api.handleVisibilityChange();
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 1);
  assert.equal(h.context.deferredVisibilityRecoveryRef.current, false);
  assert.equal(h.context.sessionActiveRef.current, false);
});

test('recovery waits for an in-flight completion, then shows server completion and schedules once', async () => {
  const finish = dispatchDeferred();
  const order = dispatchAssignment('accepted');
  const h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === 'finish_dispatch_assignment_secure') return finish.promise;
    if (name === RECOVER_DISPATCH_RPC) return recoveredDispatch(null);
    assert.equal(name, PREPARE_DISPATCH_RPC);
    return preparedDispatch();
  } });
  h.context.currentOrder = order;
  h.context.currentOrderRef.current = order;
  const completing = h.api.handleCompleteOrder();
  await flushDispatchMicrotasks();
  await h.api.handleCompleteOrder();
  assert.equal(h.rpcCalls('finish_dispatch_assignment_secure').length, 1);
  const recovery = h.api.restart();
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 0, 'Recovery waits for the finish write to settle');
  finish.resolve({ data: { success: true, status: 'completed' }, error: null });
  await completing;
  await recovery;
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls('finish_dispatch_assignment_secure').length, 1);
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 1);
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC).length, 1);
  assert.equal(h.context.currentOrderRef.current, null);
  assert.equal(h.state.setCurrentOrder, null);
  assert.equal(h.context.sessionActiveRef.current, true);
  assert.equal(h.context.finishingDispatchRef.current, null);
});

test('recovery waits for an in-flight error report and never repeats its write', async () => {
  const finish = dispatchDeferred();
  const order = dispatchAssignment('accepted');
  const h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === 'finish_dispatch_assignment_secure') return finish.promise;
    if (name === RECOVER_DISPATCH_RPC) return recoveredDispatch(null);
    assert.equal(name, PREPARE_DISPATCH_RPC);
    return preparedDispatch();
  } });
  h.context.currentOrder = order;
  h.context.currentOrderRef.current = order;
  h.context.errorReason = 'local test';
  const reporting = h.api.handleSubmitError();
  await flushDispatchMicrotasks();
  await h.api.handleSubmitError();
  assert.equal(h.rpcCalls('finish_dispatch_assignment_secure').length, 1);
  const recovery = h.api.restart();
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 0);
  finish.resolve({ data: { success: true, status: 'error' }, error: null });
  await reporting;
  await recovery;
  await flushDispatchMicrotasks();
  assert.equal(h.rpcCalls('finish_dispatch_assignment_secure').length, 1);
  assert.equal(h.rpcCalls(RECOVER_DISPATCH_RPC).length, 1);
  assert.equal(h.rpcCalls(PREPARE_DISPATCH_RPC).length, 1);
  assert.equal(h.context.currentOrderRef.current, null);
  assert.equal(h.context.finishingDispatchRef.current, null);
});

test('continuous prepare failures exhaust the cross-recovery budget instead of looping or replaying writes', async () => {
  const h = dispatchRecoveryHarness({ rpc: async name => {
    if (name === RECOVER_DISPATCH_RPC) return recoveredDispatch();
    assert.equal(name, PREPARE_DISPATCH_RPC);
    return { data: null, error: dispatchNetworkError() };
  } });
  await h.api.schedule();
  await flushDispatchMicrotasks();
  assert.deepEqual(h.calls.map(call => call.name), [
    PREPARE_DISPATCH_RPC, RECOVER_DISPATCH_RPC, PREPARE_DISPATCH_RPC, RECOVER_DISPATCH_RPC,
    PREPARE_DISPATCH_RPC, RECOVER_DISPATCH_RPC, PREPARE_DISPATCH_RPC,
  ]);
  assert.deepEqual(h.rpcCalls(PREPARE_DISPATCH_RPC).map(call => call.generation), [0, 1, 2, 3],
    'Each prepare belongs to a fresh reconciled lifecycle, never a retry of the same write');
  assert.deepEqual(h.rpcCalls(RECOVER_DISPATCH_RPC).map(call => call.args.p_operation_id), h.operationIds);
  assert.equal(new Set(h.operationIds).size, 3);
  assert.deepEqual(h.rpcCalls(RECOVER_DISPATCH_RPC).map(call => call.args.p_expected_session_id),
    Array(3).fill('dispatch-session'));
  assert.equal(h.context.dispatchRecoveryFailuresRef.current.count, 4);
  assert.equal(h.pauses().length, 1);
  assert.equal(h.context.dispatchPausedRef.current, true);
  assert.equal(h.context.preparingDispatchRef.current, null);
  assert.equal(h.context.recoveryInFlightRef.current, null);
  assert.equal(h.context.visibilityRestartPromiseRef.current, null);
  assert.equal(h.rpcCalls(ASSIGN_DISPATCH_RPC).length, 0);
  assert.deepEqual([...h.clock.pending.values()].map(timer => timer.delay), [300_000]);
  await h.clock.advance(10);
  assert.equal(h.calls.length, 7, 'Exhaustion must not leave a fast recovery loop running');
});
