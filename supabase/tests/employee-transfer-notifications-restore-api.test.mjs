import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = `${root}src/lib/employeeTransfer/notificationsRestoreApi.ts`;
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), JOB = id(2), SITE = id(3), PACKAGE = id(4), OTHER = id(5);
const SECRET = 'never-echo-notification-restore-token-or-backend-details';
const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64);
const sha = text => createHash('sha256').update(text).digest('hex');
const TABLES = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const INITIAL = [TABLES[0], TABLES[1], TABLES[10], TABLES[2], TABLES[3]];
const STAGES = [TABLES[5], TABLES[8], 'execution_links', TABLES[9], TABLES[11], TABLES[12], TABLES[4], TABLES[6], TABLES[7]];
const RPC = { begin: 'employee_import_notifications_begin', chunk: 'employee_import_notifications_chunk',
  verify: 'employee_import_notifications_verify', status: 'get_employee_import_notifications_restore_status' };
function catalog(rows = {}) {
  const table = key => ({ key, rows: rows[key] ?? 0, bytes: (rows[key] ?? 0) * 100,
    row_hashes_sha256: sha(rows[key] ? `fixture:${key}` : '') });
  const identity = { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE, processing_orders: 0,
    tables: ['accounts', 'credentials', 'orders'].map(key => table(key)), full_site_complete: false };
  return { version: 1, scope: 'site-notifications', site_id: SITE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE,
      identity_catalog: structuredClone(identity), tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries',
        'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'].map(key => table(key)), full_site_complete: false },
    date_runs_supported: !!rows[TABLES[6]], tables: TABLES.map(table), full_site_complete: false };
}
const richCatalog = () => catalog(Object.fromEntries(TABLES.map((key, index) => [key, [2, 3, 4, 5, 1, 201, 1, 1, 200, 401, 6, 1, 1][index]])));
function work(cat) {
  const totals = Object.fromEntries(cat.tables.map(t => [t.key, t.rows]));
  return STAGES.flatMap(key => {
    const size = totals[key === 'execution_links' ? TABLES[5] : key];
    return Array.from({ length: Math.max(1, Math.ceil(size / 200)) }, (_, i) => ({ key, rows: Math.min(200, size - i * 200) }));
  });
}
function receipt(operation, next = 0, options = {}, cat = catalog()) {
  const chunks = work(cat), totals = Object.fromEntries(cat.tables.map(t => [t.key, t.rows]));
  const counts = Object.fromEntries(TABLES.map(key => [key, INITIAL.includes(key) ? totals[key] : 0]));
  let linked = 0;
  for (const chunk of chunks.slice(0, next)) {
    if (chunk.key === 'execution_links') linked += chunk.rows;
    else counts[chunk.key] += chunk.rows;
  }
  const verified = options.verified ?? operation === 'verify';
  return { success: true, scope: 'site-notifications', operation, plan_hash: HASH, source_site_id: SITE, package_id: PACKAGE,
    stage: verified ? 'done' : next === chunks.length ? 'ready_to_verify' : 'restoring', counts, totals, next_chunk: next,
    total_chunks: chunks.length, linked_executions: linked, generation: String(next), verified,
    repeated: operation === 'status', chunk_no: operation === 'chunk' ? next - 1 : null,
    rows: operation === 'chunk' ? chunks[next - 1]?.rows : 0,
    automation_pending: true, maintenance: true, replacement_ready: false, full_site_complete: false, ...options };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('local cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const redacted = error => {
  assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false); assert.equal('cause' in error, false); return true;
};
const uncertain = error => {
  redacted(error); assert.match(error.message, /outcome is unknown or unconfirmed/);
  assert.match(error.message, /Read server status/); assert.match(error.message, /Cancellation does not prove rollback/);
  assert.match(error.message, /No automatic write retry/); return true;
};
const cancelled = error => uncertain(error) && error.name === 'AbortError';
const getProxy = (value, hits) => new Proxy(value, { get() { hits.n++; throw Error(SECRET); } });
const descriptorProxy = value => new Proxy(value, { getOwnPropertyDescriptor() { throw Error(SECRET); } });
function accessor(value, key, hits) {
  Object.defineProperty(value, key, { enumerable: true, configurable: true, get() { hits.n++; throw Error(SECRET); } }); return value;
}
mock.method(globalThis, 'fetch', () => assert.fail('network/production access forbidden'));
after(() => mock.restoreAll());

// Execute the real public factory and complete dependency validators. Only auth/RPC transport is mocked.
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/notificationsRestoreApi.ts';
  export {validateNotificationsCatalog} from './src/lib/employeeTransfer/notificationsTransfer.ts';
  export {setHarness} from 'restore-test:state';`, resolveDir: root, loader: 'js' }, bundle: true, write: false,
  platform: 'browser', format: 'esm', target: 'es2020', plugins: [{ name: 'isolated-notification-restore', setup(builder) {
    builder.onResolve({ filter: /^(?:restore-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, entry);
      return { path: args.path, namespace: 'restore-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'restore-test' }, ({ path }) => {
      if (path === 'restore-test:state') return { contents: 'let h; export const setHarness=v=>{h=v;}; export const current=()=>h;' };
      if (path === '../auth') return { contents: `import {current} from 'restore-test:state';
        export function getAdminFinancialSessionToken(){const h=current(); h.reads++; if(h.authError) throw h.authError; return h.session;}` };
      return { contents: `import {current} from 'restore-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { calls: [], replies: [], reads: 0, session: SESSION,
    respond(data) { h.replies.push({ data }); }, rpc(name, args) {
      assert.ok(Object.values(RPC).includes(name), `forbidden RPC ${name}`);
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      assert.ok(h.replies.length, `unexpected RPC ${name}`);
      const reply = h.replies.shift(); if (reply.throw) throw reply.throw;
      const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (reply.reject) throw reply.reject;
          return reply.wait ?? reply.envelope ?? { data: reply.data, error: reply.error ?? null };
        }).then(resolve, reject);
      } }; return query;
    } };
  api.setHarness(h); return h;
}
async function begun(h, cat = catalog()) {
  const session = api.createNotificationsRestoreSession(JOB, cat); h.respond(receipt('begin', 0, {}, cat)); await session.begin(HASH); return session;
}
async function resumed(h, next, cat = catalog(), verified = false) {
  const session = api.createNotificationsRestoreSession(JOB, cat); h.respond(receipt('status', next, { verified }, cat)); await session.status(); return session;
}
async function blockedWrites(h, session) {
  const before = h.calls.length;
  // Queued valid replies make unintended RPCs fail the call-count assertion, not merely run out of mocks.
  h.respond(receipt('begin', 0, { repeated: true })); h.respond(receipt('chunk', 1)); h.respond(receipt('verify', 9));
  await assert.rejects(session.begin(HASH), uncertain); await assert.rejects(session.chunk(0), uncertain); await assert.rejects(session.verify(), uncertain);
  assert.equal(h.calls.length, before); h.replies.length = 0;
}

// Group related invalid values by invariant rather than multiplying every value by every operation.
test('SQL27 has exactly four public signatures and receipt fields matching the public factory', async () => {
  const sql = await readFile(`${root}supabase/migrations/20261102000027_restore_site_notifications.sql`, 'utf8');
  const signatures = Object.fromEntries([...sql.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(([^)]*)\)/g)].map(([, name, args]) => [name, args]));
  assert.deepEqual(signatures, { [RPC.begin]: 'p_admin_session_token uuid,p_job_token uuid,p_plan_hash text',
    [RPC.chunk]: 'p_admin_session_token uuid,p_job_token uuid,p_chunk_no integer', [RPC.verify]: 'p_admin_session_token uuid,p_job_token uuid',
    [RPC.status]: 'p_admin_session_token uuid,p_job_token uuid' });
  const body = sql.slice(sql.indexOf('CREATE FUNCTION private.employee_transfer_notification_restore_receipt'), sql.indexOf('CREATE FUNCTION public.employee_import_notifications_begin'));
  for (const key of Object.keys(receipt('begin'))) assert.ok(body.includes(`'${key}'`), key);
  const h = harness(), s = api.createNotificationsRestoreSession(JOB, catalog());
  assert.deepEqual(Object.keys(s).sort(), ['begin', 'chunk', 'status', 'verify']); assert.equal(h.calls.length, 0); assert.equal(h.reads, 0);
});
test('full 13-table multi-chunk flow preserves counts, link phase, generation and exact RPC arguments with fresh tokens', async () => {
  const h = harness(), cat = richCatalog(), s = api.createNotificationsRestoreSession(JOB, cat), signal = new AbortController().signal;
  const invoke = async (operation, next, options = {}) => {
    h.session = id(100 + h.calls.length); h.respond(receipt(operation, next, options, cat));
    const result = await (operation === 'begin' ? s.begin(HASH, signal) : operation === 'chunk' ? s.chunk(next - 1, signal) : s[operation](signal));
    assert.deepEqual(result, receipt(operation, next, options, cat)); return result;
  };
  await invoke('begin', 0);
  for (let next = 1; next <= work(cat).length; next++) await invoke('chunk', next);
  await invoke('verify', work(cat).length); await invoke('status', work(cat).length, { verified: true });
  assert.equal(h.reads, h.calls.length); assert.equal(h.replies.length, 0);
  h.calls.forEach((call, index) => {
    const operation = index === 0 ? 'begin' : index <= work(cat).length ? 'chunk' : index === work(cat).length + 1 ? 'verify' : 'status';
    assert.equal(call.name, RPC[operation]); assert.deepEqual(call.signals, [signal]);
    assert.deepEqual(call.args, { p_admin_session_token: id(100 + index), p_job_token: JOB,
      ...(operation === 'begin' ? { p_plan_hash: HASH } : operation === 'chunk' ? { p_chunk_no: index - 1 } : {}) });
  });
});
test('empty catalog still requires all nine explicit empty chunks before explicit verification', async () => {
  const h = harness(), s = await begun(h); await assert.rejects(s.verify()); assert.equal(h.calls.length, 1);
  // A local invalid request requires reconciliation before continuing, never an implicit status or write.
  h.respond(receipt('status')); await s.status();
  for (let next = 1; next <= 9; next++) { h.respond(receipt('chunk', next)); assert.equal((await s.chunk(next - 1)).rows, 0); }
  assert.equal(h.calls.length, 11); h.respond(receipt('verify', 9)); assert.equal((await s.verify()).stage, 'done');
});
test('factory rejects malformed job tokens, including newline, without coercion or RPC', () => {
  for (const value of [null, '', SECRET, JOB + '\n', JOB + '\r\n', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', { toString() { throw Error(SECRET); } }]) {
    const h = harness(); assert.throws(() => api.createNotificationsRestoreSession(value, catalog()), redacted); assert.equal(h.calls.length, 0);
  }
});
test('factory validates complete identity and finance dependency catalogs, including their shared identity binding', () => {
  const patches = [c => { c.identity_catalog = null; }, c => { c.finance_catalog = null; }, c => { c.identity_catalog.package_id = OTHER; },
    c => { c.finance_catalog.site_id = OTHER; }, c => { c.finance_catalog.identity_catalog.package_id = OTHER; },
    c => { c.identity_catalog.tables.pop(); }, c => { c.finance_catalog.tables.reverse(); },
    c => { c.finance_catalog.identity_catalog.tables[0].row_hashes_sha256 = HASH; }, c => { c.identity_catalog.processing_orders = -1; },
    c => { c.finance_catalog.full_site_complete = true; }];
  for (const patch of patches) {
    const h = harness(), c = catalog(); patch(c); assert.throws(() => api.validateNotificationsCatalog(c));
    assert.throws(() => api.createNotificationsRestoreSession(JOB, c), redacted); assert.equal(h.calls.length, 0);
  }
});
test('factory rejects newline in every dependency digest and nested site/package UUID', () => {
  const paths = [['site_id'], ['package_id'], ['identity_catalog', 'site_id'], ['identity_catalog', 'package_id'],
    ['finance_catalog', 'site_id'], ['finance_catalog', 'package_id'], ['finance_catalog', 'identity_catalog', 'site_id'],
    ['finance_catalog', 'identity_catalog', 'package_id']];
  for (const path of paths) {
    const h = harness(), c = catalog(), parent = path.slice(0, -1).reduce((o, key) => o[key], c); parent[path.at(-1)] += '\n';
    assert.throws(() => api.createNotificationsRestoreSession(JOB, c), redacted); assert.equal(h.calls.length, 0);
  }
  for (const branch of [c => c.tables, c => c.identity_catalog.tables, c => c.finance_catalog.tables, c => c.finance_catalog.identity_catalog.tables]) {
    const h = harness(), c = catalog(); branch(c)[0].row_hashes_sha256 += '\n';
    assert.throws(() => api.createNotificationsRestoreSession(JOB, c), redacted); assert.equal(h.calls.length, 0);
  }
});
test('catalog checks ordered tables, empty digest, limits, date-runs capability and exact metadata', () => {
  const patches = [c => { c.tables.reverse(); }, c => { c.tables.pop(); }, c => { c.tables[0].row_hashes_sha256 = HASH; },
    c => { c.tables[0].rows = 1; }, c => { c.tables[0].rows = 500001; c.tables[0].bytes = 1; },
    c => { c.tables[0].rows = 1; c.tables[0].bytes = 268435457; },
    c => { for (const t of c.tables.slice(0, 5)) Object.assign(t, { rows: 1, bytes: 268435456, row_hashes_sha256: HASH }); },
    c => { Object.assign(c.tables[6], { rows: 1, bytes: 1, row_hashes_sha256: HASH }); }, c => { c.scope = 'notification-backup'; },
    c => { c.full_site_complete = true; }, c => { c.raw_error = SECRET; }];
  for (const patch of patches) {
    const h = harness(), c = catalog(); patch(c); assert.throws(() => api.createNotificationsRestoreSession(JOB, c), redacted); assert.equal(h.calls.length, 0);
  }
});
test('caller catalog, RPC response and frozen receipt cannot rewrite the session snapshot', async () => {
  const h = harness(), cat = richCatalog(), original = structuredClone(cat), s = api.createNotificationsRestoreSession(JOB, cat);
  cat.tables[5].rows = 0; cat.site_id = OTHER; cat.identity_catalog.package_id = OTHER; cat.finance_catalog.tables[0].rows = 999;
  const server = receipt('begin', 0, {}, original); h.respond(server); const result = await s.begin(HASH);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.counts)); assert.ok(Object.isFrozen(result.totals));
  assert.throws(() => { result.next_chunk = 99; }, TypeError); assert.throws(() => { result.counts.messages = 99; }, TypeError);
  server.plan_hash = OTHER_HASH; server.counts.messages = 99; server.totals.notification_automation_executions = 0;
  h.respond(receipt('chunk', 1, {}, original)); assert.equal((await s.chunk(0)).counts.notification_automation_executions, 200);
});
test('catalog accessors, sparse arrays and throwing descriptor proxies are rejected without leaking details', () => {
  for (const shape of ['root getter', 'nested getter', 'array getter', 'sparse', 'symbol', 'class', 'descriptor proxy']) {
    const h = harness(), hits = { n: 0 }; let c = catalog();
    if (shape === 'root getter') accessor(c, 'identity_catalog', hits);
    if (shape === 'nested getter') accessor(c.finance_catalog.identity_catalog, 'site_id', hits);
    if (shape === 'array getter') accessor(c.tables, '0', hits);
    if (shape === 'sparse') delete c.tables[0];
    if (shape === 'symbol') c.tables[Symbol('secret')] = SECRET;
    if (shape === 'class') Object.setPrototypeOf(c, class {}.prototype);
    if (shape === 'descriptor proxy') c = descriptorProxy(c);
    assert.throws(() => api.createNotificationsRestoreSession(JOB, c), redacted); assert.equal(hits.n, 0); assert.equal(h.calls.length, 0);
  }
});
test('valid descriptor-only proxy catalog and receipt never invoke proxy property getters', async () => {
  const h = harness(), hits = { n: 0 }, cat = catalog();
  cat.tables = getProxy(cat.tables.map(t => getProxy(t, hits)), hits); cat.identity_catalog = getProxy(cat.identity_catalog, hits);
  cat.finance_catalog.identity_catalog = getProxy(cat.finance_catalog.identity_catalog, hits); cat.finance_catalog = getProxy(cat.finance_catalog, hits);
  const s = api.createNotificationsRestoreSession(JOB, getProxy(cat, hits)), data = receipt('begin');
  data.counts = getProxy(data.counts, hits); data.totals = getProxy(data.totals, hits); h.respond(getProxy(data, hits));
  assert.deepEqual(await s.begin(HASH), receipt('begin')); assert.equal(hits.n, 0);
});
test('begin plan hash is lowercase and whole-string anchored, before auth or transport', async () => {
  for (const digest of [HASH + '\n', HASH + '\r\n', HASH.toUpperCase(), 'a'.repeat(63), null, { toString() { throw Error(SECRET); } }]) {
    const h = harness(), s = api.createNotificationsRestoreSession(JOB, catalog()); h.respond(receipt('begin'));
    await assert.rejects(s.begin(digest), uncertain); assert.equal(h.calls.length, 0); assert.equal(h.reads, 0);
  }
});
test('fresh authentication failures and malformed session tokens are sanitized without sending RPC', async () => {
  for (const value of [null, SECRET, SESSION + '\n', SESSION + '\r\n', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
    const h = harness(), s = api.createNotificationsRestoreSession(JOB, catalog()); h.session = value; h.respond(receipt('begin'));
    await assert.rejects(s.begin(HASH), uncertain); assert.equal(h.calls.length, 0); assert.equal(h.reads, 1);
  }
  const h = harness(), s = api.createNotificationsRestoreSession(JOB, catalog()); h.authError = Error(SECRET);
  await assert.rejects(s.status(), uncertain); assert.equal(h.calls.length, 0);
});
test('receipt rejects wrong source/package/hash/operation, unsafe flags and unknown fields', async () => {
  for (const patch of [{ source_site_id: OTHER }, { package_id: OTHER }, { plan_hash: OTHER_HASH }, { plan_hash: HASH + '\n' },
    { plan_hash: HASH.toUpperCase() }, { operation: 'status' }, { scope: 'notification-configuration' }, { success: false },
    { automation_pending: false }, { maintenance: false }, { replacement_ready: true }, { full_site_complete: true }, { raw_error: SECRET }]) {
    const h = harness(), s = api.createNotificationsRestoreSession(JOB, catalog()); h.respond({ ...receipt('begin'), ...patch });
    await assert.rejects(s.begin(HASH), uncertain); await blockedWrites(h, s); assert.equal(h.calls.length, 1);
  }
});
test('counts and totals are exact per table, not just equal grand totals', async () => {
  const cat = richCatalog();
  for (const branch of ['counts', 'totals']) for (const patch of [r => { r[branch][TABLES[0]]++; r[branch][TABLES[1]]--; },
    r => { delete r[branch].messages; }, r => { r[branch].orders = 0; }, r => { r[branch].messages = '0'; }]) {
    const h = harness(), s = api.createNotificationsRestoreSession(JOB, cat), r = receipt('status', 4, {}, cat); patch(r); h.respond(r);
    await assert.rejects(s.status(), uncertain); assert.equal(h.calls.length, 1);
  }
});
test('receipt rejects impossible phase, chunk count, linked count and noncanonical generation', async () => {
  const cat = richCatalog();
  for (const patch of [{ stage: 'done' }, { total_chunks: 9 }, { next_chunk: -1 }, { next_chunk: 0.5 }, { next_chunk: '4' },
    { next_chunk: work(cat).length + 1 }, { linked_executions: 201 }, { generation: 4 }, { generation: '04' },
    { generation: '4\n' }, { generation: '5' }, { verified: true }, { repeated: false }, { chunk_no: 0 }, { rows: 1 }]) {
    const h = harness(), s = api.createNotificationsRestoreSession(JOB, cat); h.respond({ ...receipt('status', 4, {}, cat), ...patch });
    await assert.rejects(s.status(), uncertain); assert.equal(h.calls.length, 1);
  }
});
test('chunk receipt checks exact requested sequence, rows and repeated acknowledgement', async () => {
  const cat = richCatalog();
  for (const patch of [{ chunk_no: 1 }, { rows: 199 }, { next_chunk: 0, generation: '0' }, { repeated: 'yes' }]) {
    const h = harness(), s = await begun(h, cat); h.respond({ ...receipt('chunk', 1, {}, cat), ...patch });
    await assert.rejects(s.chunk(0), uncertain); assert.equal(h.calls.length, 2);
  }
  const h = harness(), s = await begun(h, cat); h.respond(receipt('chunk', 2, { chunk_no: 0, rows: 200 }, cat));
  await assert.rejects(s.chunk(0), uncertain); assert.equal(h.calls.length, 2);
});
test('another client may already have committed the next chunk; known old chunks must claim repeated', async () => {
  const h = harness(), s = await begun(h); h.respond(receipt('chunk', 1, { repeated: true }));
  assert.equal((await s.chunk(0)).repeated, true); assert.equal(h.calls.length, 2);
  const resumedSession = await resumed(h, 2); h.respond(receipt('chunk', 2, { chunk_no: 0, repeated: false }));
  await assert.rejects(resumedSession.chunk(0), uncertain); assert.equal(h.calls.length, 4);
});
test('repeated chunks may report forward server progress but cannot roll back verified state', async () => {
  const h = harness(), cat = richCatalog(), s = await resumed(h, 2, cat);
  h.respond(receipt('chunk', 5, { chunk_no: 0, rows: 200, repeated: true }, cat)); assert.equal((await s.chunk(0)).linked_executions, 201);
  const done = await resumed(h, work(cat).length, cat, true);
  h.respond(receipt('chunk', work(cat).length, { chunk_no: 0, rows: 200, repeated: true, verified: false }, cat));
  await assert.rejects(done.chunk(0), uncertain);
});
test('begin and verify repetition flags agree with confirmed state; first verify may reconcile another client', async () => {
  const h = harness(), s = await begun(h); h.respond(receipt('begin'));
  await assert.rejects(s.begin(HASH), uncertain);
  const ready = await resumed(h, 9); h.respond(receipt('verify', 9, { repeated: true })); await ready.verify();
  h.respond(receipt('verify', 9)); await assert.rejects(ready.verify(), uncertain);
});
test('local chunk arguments and skipped sequence never send writes', async () => {
  for (const value of [-1, 0.5, '0', NaN, Infinity, 9, 1]) {
    const h = harness(), s = await begun(h);
    await assert.rejects(s.chunk(value), uncertain); assert.equal(h.calls.length, 1);
  }
});
test('verify is gated until all explicit chunks and rejects nonfinal or unverified receipt', async () => {
  const h = harness(), s = await resumed(h, 8); await assert.rejects(s.verify(), uncertain); assert.equal(h.calls.length, 1);
  const ready = await resumed(h, 9);
  h.respond(receipt('verify', 9, { verified: false, stage: 'ready_to_verify' })); await assert.rejects(ready.verify(), uncertain);
  assert.equal(h.calls.length, 3);
});
test('status cannot regress confirmed cursor, digest or verified flag', async () => {
  for (const data of [receipt('status', 1), receipt('status', 2, { plan_hash: OTHER_HASH })]) {
    const h = harness(), s = await resumed(h, 2); h.respond(data); await assert.rejects(s.status(), uncertain); await blockedWrites(h, s);
  }
  const h = harness(), s = await resumed(h, 9, catalog(), true); h.respond(receipt('status', 9)); await assert.rejects(s.status(), uncertain);
});
test('new factory resumes solely from status and continues next chunk using a new login token', async () => {
  const h = harness(), original = await begun(h); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(original.chunk(0), uncertain);
  h.session = OTHER; const s = api.createNotificationsRestoreSession(JOB, catalog());
  await assert.rejects(s.chunk(1), uncertain); await assert.rejects(s.verify(), uncertain); assert.equal(h.calls.length, 2);
  h.respond(receipt('status', 1)); await s.status(); h.respond(receipt('chunk', 2)); await s.chunk(1);
  assert.deepEqual(h.calls.slice(-2).map(c => c.args.p_admin_session_token), [OTHER, OTHER]);
  assert.deepEqual(h.calls.map(c => c.name), [RPC.begin, RPC.chunk, RPC.status, RPC.chunk]);
});
test('new factory can resume final verified status and explicitly repeat begin/chunk/verify', async () => {
  const h = harness(), s = await resumed(h, 9, catalog(), true);
  h.respond(receipt('begin', 9, { verified: true, repeated: true })); await s.begin(HASH);
  h.respond(receipt('chunk', 9, { chunk_no: 0, verified: true, repeated: true })); await s.chunk(0);
  h.respond(receipt('verify', 9, { repeated: true })); await s.verify(); assert.equal(h.calls.length, 4);
});
test('malformed receipts and thrown transport failures are redacted and writes never auto-retry', async () => {
  for (const mode of ['error', 'reject', 'throw', 'malformed', 'envelope getter']) {
    const h = harness(), s = await begun(h), hits = { n: 0 };
    h.replies.push(mode === 'error' ? { error: getProxy({ message: SECRET }, hits) } : mode === 'reject' ? { reject: Error(SECRET) }
      : mode === 'throw' ? { throw: Error(SECRET) } : mode === 'envelope getter' ? { envelope: accessor({ data: null, error: null }, 'data', hits) }
      : { data: { raw_error: SECRET } });
    await assert.rejects(s.chunk(0), uncertain); await tick(); assert.equal(h.calls.length, 2); await blockedWrites(h, s);
    assert.equal(hits.n, mode === 'envelope getter' ? 1 : 0);
  }
});
test('receipt accessor and throwing descriptor proxy failures are redacted and require status', async () => {
  for (const shape of ['root getter', 'nested getter', 'descriptor proxy']) {
    const h = harness(), s = await begun(h), hits = { n: 0 }; let data = receipt('chunk', 1);
    if (shape === 'root getter') accessor(data, 'next_chunk', hits);
    if (shape === 'nested getter') accessor(data.counts, 'messages', hits);
    if (shape === 'descriptor proxy') data = descriptorProxy(data);
    h.respond(data); await assert.rejects(s.chunk(0), uncertain); await blockedWrites(h, s); assert.equal(hits.n, 0);
  }
});
test('lost begin receipt blocks another begin as well as chunk/verify until explicit status', async () => {
  const h = harness(), s = api.createNotificationsRestoreSession(JOB, catalog()); h.replies.push({ reject: Error(SECRET) });
  await assert.rejects(s.begin(HASH), uncertain); await blockedWrites(h, s);
  h.respond(receipt('status')); await s.status(); h.respond(receipt('begin', 0, { repeated: true })); await s.begin(HASH);
  h.respond(receipt('chunk', 1)); await s.chunk(0); assert.deepEqual(h.calls.map(c => c.name), [RPC.begin, RPC.status, RPC.begin, RPC.chunk]);
});
test('lost chunk receipt is reconciled before explicit replay, with no duplicate automatic write', async () => {
  const h = harness(), s = await begun(h); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.chunk(0), uncertain);
  await blockedWrites(h, s); h.respond(receipt('status', 1)); await s.status();
  h.respond(receipt('chunk', 1, { repeated: true })); await s.chunk(0); h.respond(receipt('chunk', 2)); await s.chunk(1);
  assert.deepEqual(h.calls.map(c => c.name), [RPC.begin, RPC.chunk, RPC.status, RPC.chunk, RPC.chunk]);
});
test('lost verify receipt requires status even though all chunks were already confirmed', async () => {
  const h = harness(), s = await resumed(h, 9); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.verify(), uncertain);
  await blockedWrites(h, s); h.respond(receipt('status', 9, { verified: true })); await s.status();
  h.respond(receipt('verify', 9, { repeated: true })); await s.verify(); assert.equal(h.calls.length, 4);
});
test('failed status never revives stale reconciliation permission', async () => {
  const h = harness(), s = await begun(h); h.replies.push({ error: { message: SECRET } }); await assert.rejects(s.status(), uncertain);
  await blockedWrites(h, s); h.respond(receipt('status')); await s.status(); h.respond(receipt('chunk', 1)); await s.chunk(0);
});
for (const operation of ['begin', 'chunk', 'verify', 'status']) test(`pre-cancelled ${operation} sends nothing, revokes writes, and hides cancellation reason`, async () => {
  const h = harness(), s = await resumed(h, 9), controller = new AbortController(), before = h.calls.length; controller.abort(Error(SECRET));
  await assert.rejects(operation === 'begin' ? s.begin(HASH, controller.signal) : operation === 'chunk' ? s.chunk(0, controller.signal)
    : s[operation](controller.signal), cancelled);
  assert.equal(h.calls.length, before); await blockedWrites(h, s); h.respond(receipt('status', 9)); await s.status();
});
for (const operation of ['begin', 'chunk', 'verify', 'status']) test(`in-flight ${operation} cancellation is prompt; late success cannot bypass status recovery`, async () => {
  const h = harness(), s = operation === 'begin' ? api.createNotificationsRestoreSession(JOB, catalog()) : await resumed(h, operation === 'verify' ? 9 : 0);
  const wait = deferred(), started = deferred(), controller = new AbortController(), rpc = h.rpc, before = h.calls.length;
  h.rpc = (...args) => { const result = rpc(...args); started.resolve(); return result; }; h.replies.push({ wait: wait.promise });
  const run = operation === 'begin' ? s.begin(HASH, controller.signal) : operation === 'chunk' ? s.chunk(0, controller.signal) : s[operation](controller.signal);
  await soon(started.promise); assert.deepEqual(h.calls.at(-1).signals, [controller.signal]); controller.abort(Error(SECRET));
  await assert.rejects(soon(run), cancelled); await blockedWrites(h, s);
  const oldNext = operation === 'verify' ? 9 : operation === 'chunk' ? 1 : 0;
  const next = operation === 'verify' ? 9 : oldNext + 1;
  // Reconcile while the old transport is still pending; its late result cannot overwrite the newer confirmation.
  h.respond(receipt('status', next, { verified: operation === 'verify' })); await s.status();
  wait.resolve({ data: receipt(operation, oldNext), error: null }); await tick();
  if (operation === 'verify') { h.respond(receipt('verify', 9, { repeated: true })); await s.verify(); }
  else { h.respond(receipt('chunk', next + 1)); await s.chunk(next); }
  assert.equal(h.calls.length, before + 3);
});
test('one session-wide mutex blocks every other method without revoking the active request', async () => {
  const h = harness(), s = await begun(h), wait = deferred(); h.replies.push({ wait: wait.promise }); const run = s.chunk(0);
  const controller = new AbortController(); controller.abort(Error(SECRET));
  for (const action of [() => s.begin(HASH), () => s.chunk(0), () => s.verify(), () => s.status(), () => s.status(controller.signal)]) {
    await assert.rejects(action(), /already in progress/);
  }
  assert.equal(h.calls.length, 2); wait.resolve({ data: receipt('chunk', 1), error: null }); await run;
  h.respond(receipt('chunk', 2)); await s.chunk(1); assert.equal(h.calls.length, 3);
});
test('proxy signal getter failures are sanitized, including the error-handling path', async () => {
  const h = harness(), s = await begun(h), signal = new Proxy({}, { get() { throw Error(SECRET); } });
  await assert.rejects(s.status(signal), uncertain); assert.equal(h.calls.length, 1);
  const controller = new AbortController(), wait = deferred(), started = deferred(), rpc = h.rpc;
  h.rpc = (...args) => { const result = rpc(...args); started.resolve(); return result; }; h.replies.push({ wait: wait.promise });
  const run = s.status(controller.signal); await soon(started.promise);
  Object.defineProperty(controller.signal, 'aborted', { get() { throw Error(SECRET); } }); wait.reject(Error(SECRET));
  await assert.rejects(run, uncertain); assert.equal(h.calls.length, 2); await blockedWrites(h, s);
});
