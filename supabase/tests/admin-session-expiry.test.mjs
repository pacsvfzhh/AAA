import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext, createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const authPath = fileURLToPath(new URL('../../src/lib/auth.ts', import.meta.url));
const dashboardText = readFileSync(new URL('../../src/components/admin/AdminDashboard.tsx', import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile('AdminDashboard.tsx', dashboardText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbackNames = ['handlePollingSessionError', 'loadLockedAccountsCount', 'loadChatUnreadCounts', 'loadPendingCounts'];
const callbacks = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && callbackNames.includes(node.name.getText(sourceFile))) {
    callbacks[node.name.getText(sourceFile)] = node.initializer.arguments[0].getText(sourceFile);
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);
assert.equal(Object.keys(callbacks).length, callbackNames.length);
const { outputFiles } = await build({
  entryPoints: [authPath], bundle: true, write: false, format: 'cjs', platform: 'browser', logLevel: 'silent',
  plugins: [{ name: 'isolated-auth-dependencies', setup(builder) {
    builder.onResolve({ filter: /^\.\/(supabase|TabSessionManager|loginHistoryService)$/ }, args => ({ path: args.path, namespace: 'auth-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'auth-test' }, args => ({ contents: args.path === './supabase'
      ? `export const supabase={rpc(...args){globalThis.networkCalls.push(args); return Promise.resolve({data:null,error:null});}}; export const formatSupabaseError=e=>String(e?.message||e); export const isEmployeeSessionEndedError=()=>false;`
      : args.path === './TabSessionManager'
        ? `export const tabSessionManager={stopSession(){globalThis.tabStops++;}};`
        : `export const logEmployeeLogin=()=>Promise.resolve(); export const logEmployeeLogout=()=>Promise.resolve();`, loader: 'js' }));
  } }],
});
const admin = token => ({ userType: 'admin', adminSessionToken: token, user: { id: 'local-admin', username: 'local-admin', role: 'super_admin' } });
const expired = { code: 'P0001', message: 'Financial administrator session is invalid or expired.' };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(stored = admin('old-token')) {
  const session = new Map(stored ? [['work_platform_auth', JSON.stringify(stored)]] : []);
  const local = new Map([['work_platform_remembered_username', 'keep-me'], ['work_platform_remembered_auth', 'untouched']]);
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const events = new EventTarget();
  let logoutCount = 0;
  events.addEventListener('work_platform_logout', () => { logoutCount++; });
  const module = { exports: {} };
  const base = { module, exports: module.exports, window: events, Event, sessionStorage: storage(session), localStorage: storage(local), networkCalls: [], tabStops: 0, console, setTimeout, clearTimeout };
  runInNewContext(outputFiles[0].text, base);
  const auth = module.exports;
  const updates = [];
  const warnings = [];
  const calls = [];
  const context = createContext({
    ...auth,
    adminSessionExpiredRef: { current: false },
    lockedCountsRequestRef: { current: 0 },
    chatUnreadRequestRef: { current: 0 },
    pendingCountsRequestRef: { current: 0 },
    admin: { id: 'local-admin', role: 'super_admin' },
    console: { warn: (...args) => warnings.push(args) },
    formatRequestError: error => error?.message || String(error),
    isFinancialAdminSessionError: error => /financial administrator session is invalid or expired|administrator session has expired/i.test(error?.message || ''),
    setLockedAccountsCount: value => updates.push(['locks', value]),
    setNextLockedAccountExpiry: value => updates.push(['expiry', value]),
    setUnreadCustomerServiceCount: value => updates.push(['aaa', value]),
    setUnreadCccServiceCount: value => updates.push(['ccc', value]),
    setPendingWithdrawalsCount: value => updates.push(['withdrawals', value]),
    setPendingVerificationsCount: value => updates.push(['verifications', value]),
    fetchAdminChatUnreadCounts: async () => ({ rows: [] }),
    supabase: {
      rpc: async name => { calls.push(name); return { data: [], error: null }; },
      from: () => ({ select() { return this; }, eq() { return this; }, count: 0, error: null }),
    },
  });
  for (const name of callbackNames) runInContext(ts.transpile(`globalThis.${name} = ${callbacks[name]};`, { target: ts.ScriptTarget.ES2022 }), context);
  return { auth, session, local, base, calls, context, updates, warnings, logoutCount: () => logoutCount };
}

test('current rejected administrator session is removed synchronously without network or employee side effects', () => {
  const h = harness();
  assert.equal(h.auth.expireFinancialAdminSession('old-token'), true);
  assert.equal(h.session.has('work_platform_auth'), false);
  assert.equal(h.logoutCount(), 1);
  assert.equal(h.base.networkCalls.length, 0);
  assert.equal(h.base.tabStops, 0);
  assert.equal(h.local.get('work_platform_remembered_username'), 'keep-me');
  assert.equal(h.local.get('work_platform_remembered_auth'), 'untouched');
  assert.equal(h.auth.expireFinancialAdminSession('old-token'), false);
  assert.equal(h.logoutCount(), 1);
});

for (const [label, stored] of [
  ['new administrator login', admin('new-token')],
  ['employee login', { userType: 'employee', user: { id: 'employee' }, financialSessionToken: 'employee-token', sessionToken: 'employee-marker' }],
  ['no login', null],
]) {
  test(`expired old request cannot alter ${label}`, () => {
    const h = harness(stored);
    const original = h.session.get('work_platform_auth');
    assert.equal(h.auth.expireFinancialAdminSession('old-token'), false);
    assert.equal(h.session.get('work_platform_auth'), original);
    assert.equal(h.logoutCount(), 0);
    assert.equal(h.base.networkCalls.length, 0);
  });
}

for (const loader of ['loadLockedAccountsCount', 'loadChatUnreadCounts', 'loadPendingCounts']) {
  test(`${loader} handles expiry once and stops subsequent background requests`, async () => {
    const h = harness();
    if (loader === 'loadChatUnreadCounts') h.context.fetchAdminChatUnreadCounts = async () => { throw expired; };
    else h.context.supabase.rpc = async name => { h.calls.push(name); return { data: null, error: expired }; };
    await h.context[loader]();
    assert.equal(h.logoutCount(), 1);
    assert.equal(h.context.adminSessionExpiredRef.current, true);
    const beforeCalls = h.calls.length;
    await h.context[loader]();
    assert.equal(h.calls.length, beforeCalls);
    assert.equal(h.logoutCount(), 1);
    assert.equal(h.warnings.length, 0);
  });

  test(`${loader} ignores an old expiry response after a fresh administrator login`, async () => {
    const h = harness();
    const pending = deferred();
    if (loader === 'loadChatUnreadCounts') h.context.fetchAdminChatUnreadCounts = () => pending.promise;
    else h.context.supabase.rpc = () => pending.promise;
    const running = h.context[loader]();
    h.session.set('work_platform_auth', JSON.stringify(admin('new-token')));
    if (loader === 'loadChatUnreadCounts') pending.reject(expired);
    else pending.resolve({ data: null, error: expired });
    await running;
    assert.equal(h.logoutCount(), 0);
    assert.equal(h.context.adminSessionExpiredRef.current, false);
    assert.equal(h.auth.getStoredAuth().adminSessionToken, 'new-token');
    assert.equal(h.updates.length, 0);
  });

  test(`${loader} does not expire the session for network or ordinary permission failures`, async () => {
    for (const error of [new Error('Failed to fetch'), { code: '42501', message: 'permission denied for table users' }]) {
      const h = harness();
      if (loader === 'loadChatUnreadCounts') h.context.fetchAdminChatUnreadCounts = async () => { throw error; };
      else h.context.supabase.rpc = async () => ({ data: null, error });
      await h.context[loader]();
      assert.equal(h.logoutCount(), 0);
      assert.equal(h.auth.getStoredAuth().adminSessionToken, 'old-token');
      assert.equal(h.context.adminSessionExpiredRef.current, false);
      assert(h.warnings.length > 0);
    }
  });
}

test('two simultaneous expiry responses only dispatch one logout event', async () => {
  const h = harness();
  const pending = deferred();
  h.context.supabase.rpc = () => pending.promise;
  const locks = h.context.loadLockedAccountsCount();
  const counts = h.context.loadPendingCounts();
  pending.resolve({ data: null, error: expired });
  await Promise.all([locks, counts]);
  assert.equal(h.logoutCount(), 1);
  assert.equal(h.context.adminSessionExpiredRef.current, true);
});

test('expiry errors arriving after unmount cannot clear the current session', async () => {
  const h = harness();
  const pending = deferred();
  h.context.supabase.rpc = () => pending.promise;
  const running = h.context.loadLockedAccountsCount();
  h.context.lockedCountsRequestRef.current++;
  h.context.adminSessionExpiredRef.current = true;
  pending.resolve({ data: null, error: expired });
  await running;
  assert.equal(h.logoutCount(), 0);
  assert.equal(h.auth.getStoredAuth().adminSessionToken, 'old-token');
  assert.equal(h.warnings.length, 0);
});

test('unmounted request generations cannot overwrite badge counts or expire auth', async () => {
  const h = harness();
  const pending = deferred();
  h.context.supabase.rpc = () => pending.promise;
  const running = h.context.loadLockedAccountsCount();
  h.context.lockedCountsRequestRef.current++;
  h.context.adminSessionExpiredRef.current = true;
  pending.resolve({ data: [{ identifier_type: 'username', lock_until: '2099-01-01' }], error: null });
  await running;
  assert.equal(h.updates.length, 0);
  assert.equal(h.logoutCount(), 0);
  assert.match(dashboardText, /invalidatePollingRequests = useCallback\(\(\) => \{\s*adminSessionExpiredRef\.current = true;\s*lockedCountsRequestRef\.current\+\+;\s*chatUnreadRequestRef\.current\+\+;\s*pendingCountsRequestRef\.current\+\+;/);
  assert.match(dashboardText, /return \(\) => \{\s*invalidatePollingRequests\(\);/);
});
