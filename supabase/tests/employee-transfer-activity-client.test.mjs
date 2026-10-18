import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SESSION = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'never-echo-activity-password-or-backend-text';
const PLAN = 'a'.repeat(64), TIME = '2024-02-29T12:34:56.123456+00:00';
const TABLES = ['employee_login_history', 'work_sessions', 'work_stop_markers'];
const CONFLICTS = ['activity_target_not_empty', 'activity_uuid_collision', 'source_employee_missing', 'work_duration_out_of_range'];
const PRECISE = '12345678901234567890.12345678901234567890';
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
const counts = (n = 1) => Object.fromEntries(TABLES.map(key => [key, n]));
const plan = (totals = counts(), employees = 1) => ({ scope: 'employee-activity', can_restore: true, counts: totals, employees,
  running_work_sessions: totals.work_sessions, conflicts: [], plan_hash: PLAN, ...flags() });
const verifyReceipt = (totals = counts(), employees = 1) => ({ success: true, scope: 'employee-activity', counts: totals,
  completed_employees: employees, total_employees: employees, verified: true, repeated: false, ...flags() });
const applyReceipt = (employee = id(1)) => ({ ...verifyReceipt(), employee_id: employee });
const verified = () => ({ verified: true, scope: 'employee-activity', full_site_complete: false });
const closed = () => ({ success: true, scope: 'employee-activity', full_site_complete: false });
const bound = () => ({ ...closed(), repeated: false });
const row = (key, n = 1) => ({
  employee_login_history: { id: id(n), user_id: id(1), username: '员工é é 𠮷', employee_id: 'E-1', action_type: n % 2 ? 'login' : 'logout',
    ip_address: null, user_agent: '原文𠮷', session_id: 'history-' + 'b'.repeat(64), created_at: TIME,
    device_info: { id: 'device', nested: [{ id: 'child', precise: 0 }, { id: 'sibling' }], escaped: 'braces {} [], colon : quote " slash \\' }, device_info_is_sql_null: false },
  work_sessions: { id: id(n), user_id: id(1), start_time: TIME, end_time: null, duration_minutes: 0, created_at: TIME, last_heartbeat_at: TIME },
  work_stop_markers: { id: id(n), user_id: id(n), stopped_at: TIME },
})[key];
const line = (key, n) => JSON.stringify(row(key, n)).replace('"precise":0', `"precise":${PRECISE}`) + '\n';
const text = (key, n) => Array.from({ length: n }, (_, i) => line(key, i + 1)).join('');
const nrows = value => value ? value.split('\n').length - 1 : 0;
const ack = value => ({ success: true, rows: nrows(value), bytes: Buffer.byteLength(value), sha256: sha(value), repeated: false });
const rowHash = value => sha((value.match(/[^\n]*\n/g) ?? []).map(item => sha(item)).join(''));
function identityCatalog(employees = 1) {
  return { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE,
    tables: ['accounts', 'credentials', 'orders'].map((key, index) => ({ key, rows: index === 0 ? employees : 0,
      bytes: index === 0 ? employees * 500 : 0, row_hashes_sha256: sha('') })), processing_orders: 0, full_site_complete: false };
}
function catalog(texts = Object.fromEntries(TABLES.map(key => [key, text(key, 1)])), employees = 1) {
  return { version: 1, scope: 'employee-activity', site_id: SITE, package_id: PACKAGE, identity_catalog: identityCatalog(employees),
    tables: TABLES.map(key => ({ key, rows: nrows(texts[key]), bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })), full_site_complete: false };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
mock.method(globalThis, 'fetch', () => assert.fail('all production/network access forbidden'));
const logs = ['log', 'info', 'warn', 'error', 'debug'].map(name => mock.method(console, name, () => {}));
after(() => { for (const log of logs) assert.equal(log.mock.callCount(), 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/activityTransfer.ts';
    export * from './src/lib/employeeTransfer/activityApi.ts'; export { setHarness } from 'activity-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'activity-transport-only', setup(builder) {
    builder.onResolve({ filter: /^(?:activity-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/activityApi.ts`);
      return { path: args.path, namespace: 'activity-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'activity-test' }, ({ path }) => {
      if (path === 'activity-test:state') return { contents: 'let h; export const setHarness = v => {h=v;}; export const current = () => h;' };
      if (path === '../auth') return { contents: `import {current} from 'activity-test:state'; export function getAdminFinancialSessionToken() {const h=current();h.reads++;return h.session;}` };
      return { contents: `import {current} from 'activity-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { calls: [], replies: [], reads: 0, session: SESSION,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      assert.ok(h.replies.length, `unexpected RPC ${name}`);
      const result = h.replies.shift(); if (result.throw) throw result.throw;
      const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
        return Promise.resolve().then(() => { if (result.reject) throw result.reject; return result.wait ?? { data: result.data, error: result.error ?? null }; }).then(resolve, reject);
      } }; return query;
    } };
  api.setHarness(h); return h;
}
async function imported(h, planned = false) {
  const s = api.createActivityImportSession(TOKEN); h.respond(bound()); await s.target.bind(catalog());
  if (planned) { h.respond(plan()); await s.plan(); } return s;
}
function fixture(sizes = [405, 405, 2], employees = 3) {
  const texts = Object.fromEntries(TABLES.map((key, index) => [key, text(key, sizes[index])]));
  const cat = catalog(texts, employees), calls = { pages: [], writes: [], open: [], bind: 0, stage: [], plan: 0, verify: 0, cleanup: 0 }, events = [], progress = [], stored = new Map();
  const f = { texts, cat, calls, events, progress, stored };
  f.source = {
    async catalog() { return f.cat; },
    async page(key, after) {
      calls.pages.push({ key, after });
      const all = f.texts[key].match(/[^\n]*\n/g) ?? [];
      let start = after === null ? 0 : all.findIndex(item => JSON.parse(item).id === after) + 1;
      const page = []; let bytes = 0;
      while (start < all.length && page.length < 200 && bytes + Buffer.byteLength(all[start]) <= 262144) { bytes += Buffer.byteLength(all[start]); page.push(all[start++]); }
      const ndjson = page.join('');
      return { table_key: key, count: page.length, ndjson, next_after: start < all.length ? JSON.parse(page.at(-1)).id : null, sha256: sha(ndjson) };
    },
    async verify() { calls.verify++; return verified(); },
  };
  f.sink = {
    async append(path, bytes) { calls.writes.push(path); stored.set(path, Buffer.concat([stored.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); },
    async abort() { calls.cleanup++; stored.clear(); },
  };
  f.files = {
    open(path) {
      calls.open.push(path); const key = TABLES.find(key => path === `data/activity-${key}.ndjson`); assert.ok(key);
      const bytes = Buffer.from(f.texts[key]);
      return { async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 97) yield bytes.subarray(i, i + 97); events.push(`eof:${key}`); } };
    },
    async abort() { calls.cleanup++; },
  };
  f.target = {
    async bind(input) { assert.deepEqual(input, f.cat); calls.bind++; assert.deepEqual(events.slice(0, 3), TABLES.map(key => `eof:${key}`)); return bound(); },
    async stage(key, chunkNo, ndjson) { calls.stage.push({ key, chunkNo, ndjson }); return ack(ndjson); },
    async plan() { calls.plan++; return plan(Object.fromEntries(f.cat.tables.map(t => [t.key, t.rows])), f.cat.identity_catalog.tables[0].rows); },
  };
  return f;
}
const exportRun = (f, options = {}) => api.exportActivityData(f.source, f.sink, { onProgress: p => f.progress.push(p), ...options });
const stageRun = (f, options = {}) => api.stageActivityImport(f.cat, f.files, f.target, { onProgress: p => f.progress.push(p), ...options });
const redacted = error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(PASSWORD), false); assert.equal('cause' in error, false); return true; };
const deviceLine = (raw, sqlNull = false, n = 1) => JSON.stringify({ ...row(TABLES[0], n), device_info: null, device_info_is_sql_null: sqlNull })
  .replace('"device_info":null', `"device_info":${raw}`) + '\n';

test('real lightweight bundle uses activity/identity/checks/SHA only; no finance, ZIP, crypto or node_modules', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['activityTransfer', 'activityApi', 'identityTransfer', 'dispatchTransfer', 'sha256']) assert.ok(inputs.some(path => path.endsWith(`/${name}.ts`)));
  assert.equal(inputs.some(path => /node_modules|\/(?:financeTransfer|financeApi|sharedExport|api|container|crypto|manifest|dispatchBackup|dispatchImport|replacementBackup)\.ts$/.test(path)), false);
  assert.equal(api.ACTIVITY_PROTOCOL, 'employee-activity-v1'); assert.deepEqual(api.ACTIVITY_TABLE_KEYS, TABLES); assert.deepEqual(api.ACTIVITY_CONFLICT_REASONS, CONFLICTS);
  assert.deepEqual(api.ACTIVITY_TRANSFER_LIMITS, { maxRows: 500000, maxTableBytes: 268435456, maxTotalBytes: 1073741824,
    maxLineBytes: 65536, maxPageRows: 200, maxPageBytes: 262144, maxChunks: 500001, maxInputBytes: 1048576 });
});
for (const [label, change] of [
  ['version', c => { c.version = 2; }], ['scope', c => { c.scope = 'employee-identity'; }], ['extra', c => { c.password = PASSWORD; }],
  ['full site', c => { c.full_site_complete = true; }], ['UUID', c => { c.site_id = 'bad'; }], ['missing package', c => { delete c.package_id; }],
  ['uppercase UUID', c => { c.package_id = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'; }], ['order', c => { c.tables.reverse(); }],
  ['missing table', c => { c.tables.pop(); }], ['unknown table', c => { c.tables[0].key = 'notifications'; }], ['extra table field', c => { c.tables[0].x = 1; }],
  ['row bound', c => { c.tables[0].rows = 500001; }], ['negative rows', c => { c.tables[0].rows = -1; }], ['fractional rows', c => { c.tables[0].rows = 0.5; }],
  ['table bytes', c => { c.tables[0].bytes = 268435457; }], ['empty mismatch', c => { c.tables[0].bytes = 0; }],
  ['hash', c => { c.tables[0].row_hashes_sha256 = 'A'.repeat(64); }], ['extra fourth table', c => { c.tables.push(c.tables[0]); }],
  ['UUID trailing newline', c => { c.site_id += '\n'; c.identity_catalog.site_id += '\n'; }],
  ['hash trailing newline', c => { c.tables[0].row_hashes_sha256 += '\n'; }],
  ['identity hash trailing newline', c => { c.identity_catalog.tables[0].row_hashes_sha256 += '\n'; }],
  ['identity site', c => { c.identity_catalog.site_id = OTHER; }], ['identity package', c => { c.identity_catalog.package_id = OTHER; }],
  ['identity shape', c => { c.identity_catalog.processing_orders = -1; }], ['sparse array', c => { delete c.tables[1]; }],
  ['iterator injection', c => { c.tables[Symbol.iterator] = () => assert.fail('iterator'); }], ['array extra', c => { c.tables.extra = true; }],
]) test(`catalog rejects ${label}`, () => { const c = catalog(); change(c); assert.throws(() => api.validateActivityCatalog(c)); });
test('catalog accepts three maximum tables and 500000-row bounds; nested identity detached', () => {
  const c = catalog(); c.tables.forEach(t => { t.rows = 500000; t.bytes = 268435456; });
  const copy = api.validateActivityCatalog(c); assert.deepEqual(copy, c); copy.identity_catalog.tables[0].rows = 99; copy.tables[0].rows = 1;
  assert.equal(c.tables[0].rows, 500000); assert.equal(c.identity_catalog.tables[0].rows, 1);
});
for (const [label, make, validate] of [
  ['catalog', catalog, api.validateActivityCatalog], ['plan', plan, api.validateActivityPlan],
  ['apply receipt', applyReceipt, api.validateActivityApplyReceipt], ['verify receipt', verifyReceipt, api.validateActivityVerifyReceipt],
]) {
  for (const descriptor of ['getter', 'hidden', 'symbol', 'inherited']) test(`${label} rejects ${descriptor} without executing it`, () => {
    const value = make(), key = Object.keys(value)[0]; let reads = 0;
    if (descriptor === 'getter') Object.defineProperty(value, key, { enumerable: true, get() { reads++; throw Error(PASSWORD); } });
    if (descriptor === 'hidden') Object.defineProperty(value, key, { enumerable: false });
    if (descriptor === 'symbol') value[Symbol('extra')] = true;
    if (descriptor === 'inherited') Object.setPrototypeOf(value, { extra: 1 });
    assert.throws(() => validate(value)); assert.equal(reads, 0);
  });
  test(`${label} snapshots null-prototype objects without proxy get traps`, () => {
    const v = make(); assert.deepEqual(validate(new Proxy(Object.assign(Object.create(null), v), { get() { throw Error(PASSWORD); } })), v);
  });
}
for (const reason of CONFLICTS) test(`plan accepts exact conflict ${reason}`, () => {
  const p = plan(); p.can_restore = false; p.conflicts = [reason]; assert.deepEqual(api.validateActivityPlan(p), p);
});
for (const [label, edit] of [
  ['false conflictfree', p => { p.can_restore = false; }], ['fake restore', p => { p.conflicts = ['source_employee_missing']; }],
  ['unknown reason', p => { p.can_restore = false; p.conflicts = ['backend raw text']; }], ['finance reason', p => { p.can_restore = false; p.conflicts = ['financial_target_not_empty']; }],
  ['object conflict', p => { p.can_restore = false; p.conflicts = [{ reason: 'source_employee_missing' }]; }],
  ['201 reasons', p => { p.can_restore = false; p.conflicts = Array(201).fill('source_employee_missing'); }],
  ['employee overflow', p => { p.employees = 500001; }], ['extra counts', p => { p.counts.wallets = 0; }], ['count overflow', p => { p.counts.work_sessions = 500001; }],
  ['hash', p => { p.plan_hash = 'bad'; }], ['running overflow', p => { p.running_work_sessions = 2; }],
  ['running negative', p => { p.running_work_sessions = -1; }], ['running fractional', p => { p.running_work_sessions = 0.5; }],
  ['missing running', p => { delete p.running_work_sessions; }], ['finance field', p => { p.pending_withdrawals = { count: 0, amount: '0' }; }],
  ['conflict accessor', p => { p.conflicts = [null]; Object.defineProperty(p.conflicts, 0, { enumerable: true, get() { assert.fail('getter'); } }); }],
]) test(`plan rejects ${label}`, () => { const p = plan(); edit(p); assert.throws(() => api.validateActivityPlan(p)); });
test('plan employees independent of history counts; exact running and conflict limits', () => {
  for (const n of [0, 500000]) { const p = plan(counts(n), 3); assert.deepEqual(api.validateActivityPlan(p), p); }
  const p = plan(counts(0), 500000); p.can_restore = false; p.conflicts = Array(200).fill('source_employee_missing');
  assert.deepEqual(api.validateActivityPlan(p), p);
});
for (const field of Object.keys(flags())) for (const [label, make, check] of [
  ['plan', plan, api.validateActivityPlan], ['apply', applyReceipt, api.validateActivityApplyReceipt], ['verify', verifyReceipt, api.validateActivityVerifyReceipt],
]) test(`${label} rejects unsafe flag ${field}`, () => { const r = make(); r[field] = !r[field]; assert.throws(() => check(r)); });
for (const [label, edit] of [
  ['false success', r => { r.success = false; }], ['scope', r => { r.scope = 'employee-finance'; }], ['extra', r => { r.secret = PASSWORD; }],
  ['unverified', r => { r.verified = false; }], ['nonboolean verified', r => { r.verified = 1; }], ['repeated', r => { r.repeated = null; }],
  ['count overflow', r => { r.counts.work_sessions = 500001; }], ['negative count', r => { r.counts.employee_login_history = -1; }],
  ['fractional count', r => { r.counts.work_stop_markers = 1.1; }], ['missing count', r => { delete r.counts.work_sessions; }],
  ['completed over total', r => { r.completed_employees = 2; }], ['total overflow', r => { r.total_employees = 500001; }],
]) for (const [kind, make, check] of [['apply', applyReceipt, api.validateActivityApplyReceipt], ['verify', verifyReceipt, api.validateActivityVerifyReceipt]]) {
  test(`${kind} receipt rejects ${label}`, () => { const r = make(); edit(r); assert.throws(() => check(r)); });
}
test('apply/verify exact shapes, completeness and independent employee totals, including no history', () => {
  assert.throws(() => api.validateActivityApplyReceipt(verifyReceipt())); assert.throws(() => api.validateActivityVerifyReceipt(applyReceipt()));
  for (const employee of [null, 'bad', 1]) assert.throws(() => api.validateActivityApplyReceipt({ ...applyReceipt(), employee_id: employee }));
  assert.throws(() => api.validateActivityApplyReceipt({ ...applyReceipt(), completed_employees: 0 }));
  assert.throws(() => api.validateActivityVerifyReceipt({ ...verifyReceipt(), completed_employees: 0 }));
  for (const [n, employees] of [[0, 0], [0, 3], [500000, 1]]) assert.deepEqual(api.validateActivityVerifyReceipt(verifyReceipt(counts(n), employees)), verifyReceipt(counts(n), employees));
});
test('login history fixes all 11 protocol fields including the required SQL NULL discriminator', () => {
  assert.deepEqual(Object.keys(row(TABLES[0])), ['id', 'user_id', 'username', 'employee_id', 'action_type',
    'ip_address', 'user_agent', 'session_id', 'created_at', 'device_info', 'device_info_is_sql_null']);
});
const nullable = { employee_login_history: ['ip_address', 'user_agent', 'session_id', 'created_at', 'device_info'],
  work_sessions: ['end_time', 'duration_minutes', 'created_at', 'last_heartbeat_at'], work_stop_markers: [] };
for (const key of TABLES) {
  test(`${key} preserves exact actual columns, nullable values and UTC microseconds`, () => { assert.equal(api.validateActivityRow(line(key, 1), key), row(key).id); });
  for (const [label, edit] of [
    ['unknown field', r => { r.extra = PASSWORD; }], ['missing field', r => { delete r.user_id; }], ['bad user', r => { r.user_id = 'bad'; }],
    ['null user', r => { r.user_id = null; }], ['bad id', r => { r.id = 'bad'; }], ['null id', r => { r.id = null; }],
    ['UUID trailing newline', r => { r.user_id += '\n'; }],
    ['duplicate key', null], ['escaped duplicate key', null], ['unpaired surrogate', r => { r.user_id = '\ud800'; }],
  ]) test(`${key} rejects ${label}`, () => {
    const r = row(key); if (edit) edit(r); let value = JSON.stringify(r);
    if (label === 'duplicate key') value = value.replace('{', `{"user_id":"${id(1)}",`);
    if (label === 'escaped duplicate key') value = value.replace('{', `{"\\u0075ser_id":"${id(1)}",`);
    assert.throws(() => api.validateActivityRow(value, key));
  });
  for (const [field, value] of Object.entries(row(key))) {
    if (field !== 'device_info') test(`${key}.${field} rejects wrong non-null type`, () => {
      const r = row(key); r[field] = typeof value === 'number' ? '1' : {}; assert.throws(() => api.validateActivityRow(JSON.stringify(r), key));
    });
    test(`${key}.${field} required presence and exact nullability`, () => {
      const r = row(key); delete r[field]; assert.throws(() => api.validateActivityRow(JSON.stringify(r), key)); r[field] = null;
      if (nullable[key].includes(field)) api.validateActivityRow(JSON.stringify(r), key); else assert.throws(() => api.validateActivityRow(JSON.stringify(r), key));
    });
    if (value === TIME) for (const invalidTime of [
      '2024-02-30T00:00:00Z', '1900-02-29T00:00:00Z', '0000-01-01T00:00:00Z', '2024-01-01T24:00:00Z',
      '2024-01-01T00:00:60Z', '2024-01-01', '2024-01-01T00:00:00', '2024-01-01T00:00:00.1234567Z', '2024-01-01T00:00:00+08:00', '2024-01-01T00:00:00Z\n',
    ]) test(`${key}.${field} rejects invalid UTC time ${invalidTime}`, () => {
      const r = row(key); r[field] = invalidTime; assert.throws(() => api.validateActivityRow(JSON.stringify(r), key));
    });
  }
  test(`${key} all UUID cursors order by lowercase text and reject duplicates/reversal`, () => {
    const ndjson = text(key, 2), p = { table_key: key, count: 2, ndjson, next_after: id(2), sha256: sha(ndjson) };
    assert.equal(api.validateActivityPage(p, key, id(0)).next_after, id(2));
    for (const after of [id(1), id(2), 1, '9', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']) assert.throws(() => api.validateActivityPage(p, key, after));
    for (const raw of [line(key, 1) + line(key, 1), line(key, 2) + line(key, 1)]) assert.throws(() => api.validateActivityPage({ ...p, ndjson: raw, sha256: sha(raw) }, key, null));
  });
}
for (const session of ['history-' + '0'.repeat(64), 'history-' + 'f'.repeat(64), null]) test(`redacted session accepts ${session}`, () => {
  api.validateActivityRow(JSON.stringify({ ...row(TABLES[0]), session_id: session }), TABLES[0]);
});
for (const [field, value] of [['session_id', TOKEN], ['session_id', 'history-' + 'A'.repeat(64)], ['session_id', 'history-' + 'a'.repeat(63)],
  ['session_id', 'history-' + 'a'.repeat(65)], ['session_id', 'history-' + 'a'.repeat(64) + '\n'], ['session_id', ''], ['action_type', 'LOGIN'], ['action_type', 'other'], ['username', '\u0000'], ['user_agent', '\udc00']]) {
  test(`login rejects unsafe ${field} ${JSON.stringify(value)}`, () => { assert.throws(() => api.validateActivityRow(JSON.stringify({ ...row(TABLES[0]), [field]: value }), TABLES[0])); });
}
test('stop marker synthetic UUID must equal user; unfinished work session remains NULL, never synthesized locally', () => {
  assert.throws(() => api.validateActivityRow(JSON.stringify({ ...row(TABLES[2]), user_id: OTHER }), TABLES[2]));
  api.validateActivityRow(JSON.stringify({ ...row(TABLES[1]), end_time: null, last_heartbeat_at: null }), TABLES[1]);
});
for (const value of [-2147483648, 2147483647, 0, null]) test(`duration accepts PostgreSQL integer shape ${value}`, () => {
  api.validateActivityRow(JSON.stringify({ ...row(TABLES[1]), duration_minutes: value }), TABLES[1]);
});
for (const raw of ['2147483648', '-2147483649', '1.5', '1e400', '"1"', 'true']) test(`duration rejects ${raw}`, () => {
  assert.throws(() => api.validateActivityRow(line(TABLES[1], 1).replace('"duration_minutes":0', `"duration_minutes":${raw}`), TABLES[1]));
});
test('SQL NULL and JSON null are both valid but stay distinct through export, staging and row hashes', async () => {
  const key = TABLES[0], sqlNull = deviceLine('null', true), jsonNull = deviceLine('null', false);
  for (const raw of [sqlNull, jsonNull]) assert.equal(api.validateActivityRow(raw, key), id(1));
  assert.notEqual(sqlNull, jsonNull); assert.notEqual(rowHash(sqlNull), rowHash(jsonNull));
  const f = fixture([2, 0, 0]); f.texts[key] = sqlNull + deviceLine('null', false, 2); f.cat = catalog(f.texts, 3);
  const exported = await exportRun(f), imported = await stageRun(f);
  assert.equal(f.stored.get(`data/activity-${key}.ndjson`).toString(), f.texts[key]);
  assert.equal(f.calls.stage.find(page => page.key === key).ndjson, f.texts[key]);
  assert.deepEqual(f.calls.stage.find(page => page.key === key).ndjson.trimEnd().split('\n').map(raw => {
    const value = JSON.parse(raw); return [value.device_info, value.device_info_is_sql_null];
  }), [[null, true], [null, false]]);
  assert.equal(exported.entries[0].sha256, sha(f.texts[key])); assert.equal(imported.rows, 2);
  const g = fixture([1, 0, 0]); g.texts[key] = sqlNull; g.cat = catalog(g.texts, 3); const bind = g.target.bind;
  g.target.bind = async c => { const result = await bind(c); g.texts[key] = jsonNull; return result; };
  await assert.rejects(stageRun(g), e => e.stagingMayExist === true && redacted(e));
  assert.equal(g.calls.plan, 0); assert.equal(g.calls.cleanup, 1);
});
for (const [label, edit] of [
  ['missing', r => { delete r.device_info_is_sql_null; }],
  ...[null, 0, 1, 'true', 'false', {}, []].map(value => [`invalid ${JSON.stringify(value)}`, r => { r.device_info_is_sql_null = value; }]),
]) test(`login history rejects SQL NULL discriminator ${label}`, () => {
  const r = { ...row(TABLES[0]), device_info: null }; edit(r);
  assert.throws(() => api.validateActivityRow(JSON.stringify(r), TABLES[0]));
});
for (const raw of ['true', 'false', '0', PRECISE, '1e400', '-1e-400', '"null"', '""', '[]', '{}', '{"nested":null}']) {
  test(`SQL NULL discriminator true rejects non-null JSON ${raw}`, () => {
    assert.throws(() => api.validateActivityRow(deviceLine(raw, true), TABLES[0]));
  });
}
for (const raw of ['null', 'true', 'false', '0', PRECISE, '1e400', '-1e-400', '"𠮷é é"', '[]', '{}',
  '{"id":1,"left":{"id":2},"right":{"id":3},"array":[{"id":4},{"id":5}]}',
  '{"\\u0061":1,"child":{"a":2},"escaped":"\\\" { [ ] } \\\\ :"}', '{"__proto__":{"id":1},"constructor":{"id":2}}']) {
  test(`SQL NULL discriminator false accepts arbitrary JSON without flattening or reserialization ${raw}`, () => { assert.equal(api.validateActivityRow(deviceLine(raw), TABLES[0]), id(1)); });
}
for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"child":{"id":1,"id":2}}', '[{"a":1,"\\u0061":2}]',
  '{"x":1,"\\u0078":2}', '{"𠮷":1,"\\ud842\\udfb7":2}', '{"__proto__":1,"__proto__":2}',
  '{"a":"\\u0000"}', '{"\\u0000":1}', '{"a":"\\ud800"}', '{"a":"\\udc00"}', '{"\\ud800":1}', '["\\ud800x"]',
  'NaN', 'Infinity', '[undefined]', '{"a":01}', '{"a":1,}', '"raw\u0000"']) {
  test(`nested JSON rejects duplicate/escaped-equivalent keys, Unicode or syntax ${raw}`, () => { assert.throws(() => api.validateActivityRow(deviceLine(raw), TABLES[0])); });
}
test('depth includes row object, accepts 32 and rejects 33 for arrays, objects and mixed containers', () => {
  for (const kind of ['array', 'object', 'mixed']) {
    const nested = n => { let raw = '0'; for (let i = 0; i < n; i++) raw = kind === 'array' || (kind === 'mixed' && i % 2) ? `[${raw}]` : `{"x":${raw}}`; return raw; };
    api.validateActivityRow(deviceLine(nested(31)), TABLES[0]); assert.throws(() => api.validateActivityRow(deviceLine(nested(32)), TABLES[0]));
  }
});
test('nested numeric lexemes, exponent extremes and whitespace survive export and double-pass staging unchanged', async () => {
  const f = fixture([1, 0, 0], 4);
  f.texts[TABLES[0]] = deviceLine(`{ "n": ${PRECISE}, "huge": 1e400, "tiny": -1e-400, "negativeZero": -0, "sibling": { "n": 9007199254740993 } }`);
  f.cat = catalog(f.texts, 4);
  const exported = await exportRun(f); await stageRun(f);
  const path = `data/activity-${TABLES[0]}.ndjson`;
  assert.equal(f.stored.get(path).toString(), f.texts[TABLES[0]]);
  const staged = f.calls.stage.find(page => page.key === TABLES[0]).ndjson;
  assert.equal(staged, f.texts[TABLES[0]]);
  assert.ok(staged.includes(PRECISE)); assert.ok(staged.includes('9007199254740993'));
  assert.ok(staged.includes('"device_info_is_sql_null":false'));
  assert.equal(exported.entries[0].sha256, sha(f.texts[TABLES[0]]));
});
test('streamed export preserves all original nested high precision bytes, UUID cursors and bounded pages', async () => {
  const f = fixture(), r = await exportRun(f); assert.equal(r.rows, 812); assert.equal(f.calls.verify, 1); assert.equal(f.calls.cleanup, 0);
  for (const key of TABLES.slice(0, 2)) assert.deepEqual(f.calls.pages.filter(p => p.key === key).map(p => p.after), [null, id(200), id(400)]);
  for (const key of TABLES) {
    const path = `data/activity-${key}.ndjson`; assert.deepEqual(f.stored.get(path), Buffer.from(f.texts[key]));
    assert.deepEqual(r.entries.find(e => e.path === path), { path, kind: 'ndjson', bytes: Buffer.byteLength(f.texts[key]), sha256: sha(f.texts[key]) });
  }
  assert.ok(f.texts[TABLES[0]].includes(PRECISE)); assert.ok(f.progress.every(p => p.fullSiteComplete === false && p.scope === 'employee-activity'));
});
for (const [label, change] of [
  ['hash', p => { p.sha256 = 'b'.repeat(64); }], ['count', p => { p.count++; }], ['table', p => { p.table_key = TABLES[2]; }],
  ['cursor', p => { p.next_after = id(99); }], ['missing LF', p => { p.ndjson = p.ndjson.trimEnd(); p.sha256 = sha(p.ndjson); }],
  ['bytes', p => { p.ndjson = 'x'.repeat(262145); }], ['rows over', p => { p.count = 201; }], ['extra', p => { p.secret = PASSWORD; }],
  ['unordered', p => { p.ndjson = p.ndjson.match(/[^\n]*\n/g).reverse().join(''); p.sha256 = sha(p.ndjson); }],
]) test(`export rejects page ${label}, cleans and does not verify or count`, async () => {
  const f = fixture(), page = f.source.page; f.source.page = async (...args) => { const p = await page(...args); change(p); return p; };
  await assert.rejects(exportRun(f), redacted); assert.equal(f.calls.cleanup, 1); assert.equal(f.calls.verify, 0); assert.equal(f.progress.length, 0);
});
for (const label of ['table hash', 'rows', 'bytes', 'verify', 'write', 'callback']) test(`export ${label} failure discards all plaintext`, async () => {
  const f = fixture();
  if (label === 'table hash') f.cat.tables[2].row_hashes_sha256 = '0'.repeat(64);
  if (label === 'rows') f.cat.tables[2].rows++;
  if (label === 'bytes') f.cat.tables[2].bytes++;
  if (label === 'verify') f.source.verify = async () => ({ ...verified(), verified: false });
  if (label === 'write') f.sink.append = async () => { throw Error(PASSWORD); };
  await assert.rejects(exportRun(f, label === 'callback' ? { onProgress() { throw Error(PASSWORD); } } : {}), redacted); assert.equal(f.calls.cleanup, 1); assert.equal(f.stored.size, 0);
});
test('two-pass import reads ALL files before bind, stages original bounded pages and obtains plan only', async () => {
  const f = fixture(), r = await stageRun(f); assert.equal(r.rows, 812); assert.equal(f.calls.bind, 1); assert.equal(f.calls.plan, 1); assert.equal(f.calls.cleanup, 1);
  assert.deepEqual(f.calls.open, [...TABLES, ...TABLES].map(key => `data/activity-${key}.ndjson`));
  for (const key of TABLES) assert.equal(f.calls.stage.filter(p => p.key === key).map(p => p.ndjson).join(''), f.texts[key]);
  assert.deepEqual(f.calls.stage.filter(p => p.key === TABLES[0]).map(p => p.chunkNo), [0, 1, 2]);
  assert.deepEqual(r, { plan: plan(Object.fromEntries(f.cat.tables.map(t => [t.key, t.rows])), 3),
    rows: 812, bytes: Buffer.byteLength(Object.values(f.texts).join('')), fullSiteComplete: false });
});
test('zero activity with nonzero employees stages one acknowledged empty chunk per table', async () => {
  const f = fixture([0, 0, 0], 7), r = await stageRun(f); assert.equal(r.rows, 0); assert.equal(r.plan.employees, 7);
  assert.deepEqual(f.calls.stage, TABLES.map(key => ({ key, chunkNo: 0, ndjson: '' }))); assert.equal(f.calls.cleanup, 1);
});
for (const label of ['last hash', 'invalid UTF8', 'BOM', 'missing LF', 'input type', 'input size', 'throwing stream', 'unsorted UUID', 'duplicate key', 'nested duplicate', 'escaped NUL']) {
  test(`import ${label} fails before bind and cleans once`, async () => {
    const f = fixture();
    if (label === 'last hash') f.cat.tables[2].row_hashes_sha256 = '0'.repeat(64);
    if (label === 'missing LF') f.texts[TABLES[2]] = f.texts[TABLES[2]].trimEnd();
    if (label === 'unsorted UUID') f.texts[TABLES[0]] = f.texts[TABLES[0]].match(/[^\n]*\n/g).reverse().join('');
    if (label === 'duplicate key') f.texts[TABLES[0]] = f.texts[TABLES[0]].replace('{', `{"user_id":"${id(1)}",`);
    if (label === 'nested duplicate') f.texts[TABLES[0]] = f.texts[TABLES[0]].replace('"id":"device"', '"id":"device","\\u0069d":0');
    if (label === 'escaped NUL') f.texts[TABLES[0]] = f.texts[TABLES[0]].replace('device', '\\u0000');
    if (['invalid UTF8', 'BOM', 'input type', 'input size', 'throwing stream'].includes(label)) f.files.open = () => ({ async *[Symbol.asyncIterator]() {
      if (label === 'throwing stream') throw Error(PASSWORD);
      yield label === 'invalid UTF8' ? Uint8Array.from([0xc3, 0x28]) : label === 'BOM' ? Buffer.from('\ufeff' + f.texts[TABLES[0]]) : label === 'input type' ? 'bad' : new Uint8Array(1048577);
    } });
    await assert.rejects(stageRun(f), redacted); assert.equal(f.calls.bind, 0); assert.equal(f.calls.stage.length, 0); assert.equal(f.calls.cleanup, 1);
  });
}
for (const label of ['success', 'rows', 'bytes', 'sha256', 'repeated', 'extra']) test(`fake stage acknowledgement ${label} never advances progress or plan`, async () => {
  const f = fixture(); f.target.stage = async (key, no, raw) => { const a = ack(raw);
    if (label === 'extra') a.extra = PASSWORD; else a[label] = label === 'success' ? false : label === 'repeated' ? null : label === 'sha256' ? 'b'.repeat(64) : a[label] + 1; return a; };
  await assert.rejects(stageRun(f), e => e.stagingMayExist === true && redacted(e)); assert.equal(f.calls.plan, 0);
  assert.equal(f.progress.filter(p => p.phase === 'stage').length, 0); assert.equal(f.calls.cleanup, 1);
});
test('second-pass same-length nested numeric drift is detected despite correct first pass; no claimed rollback', async () => {
  const f = fixture(), bind = f.target.bind; f.target.bind = async c => { const b = await bind(c); f.texts[TABLES[0]] = f.texts[TABLES[0]].replace(PRECISE, '22345678901234567890.12345678901234567890'); return b; };
  await assert.rejects(stageRun(f), e => e.stagingMayExist === true && redacted(e)); assert.ok(f.calls.stage.length > 0); assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
});
test('plan mismatched counts or identity employee count fail; matching conflicted plans never auto-apply', async () => {
  for (const employees of [2, 4]) { const f = fixture([1, 1, 1], 3); f.target.plan = async () => plan(counts(), employees); await assert.rejects(stageRun(f), e => e.stagingMayExist === true); }
  const f = fixture(); f.target.plan = async () => plan(); await assert.rejects(stageRun(f), e => e.stagingMayExist === true);
  const g = fixture([1, 1, 1], 1); g.target.plan = async () => ({ ...plan(), can_restore: false, conflicts: ['activity_target_not_empty'] });
  assert.equal((await stageRun(g)).plan.can_restore, false);
});
for (const mode of ['export', 'stage']) test(`${mode} respects backpressure and counts only confirmed writes`, async () => {
  const f = fixture(), entered = deferred(), gate = deferred(), owner = mode === 'export' ? f.sink : f.target, method = mode === 'export' ? 'append' : 'stage', write = owner[method];
  owner[method] = async (...args) => { entered.resolve(); await gate.promise; return write(...args); };
  const pending = mode === 'export' ? exportRun(f) : stageRun(f); await entered.promise;
  assert.equal(f.progress.filter(p => p.phase === mode).length, 0); if (mode === 'export') assert.equal(f.calls.pages.length, 1);
  gate.resolve(); await pending;
});
for (const phase of ['catalog', 'page', 'write', 'verify', 'read', 'bind', 'stage', 'plan']) test(`cancel blocked ${phase}: prompt cleanup, no late progress/state`, async () => {
  const f = fixture([1, 1, 1]), entered = deferred(), gate = deferred(), c = new AbortController();
  const block = () => { entered.resolve(); return gate.promise; }; let returned = 0;
  if (['catalog', 'page', 'verify'].includes(phase)) f.source[phase] = block;
  if (phase === 'write') f.sink.append = block;
  if (phase === 'read') f.files.open = () => ({ [Symbol.asyncIterator]() { return { next: block, return() { returned++; return new Promise(() => {}); } }; } });
  if (['bind', 'stage', 'plan'].includes(phase)) f.target[phase] = block;
  const isImport = ['read', 'bind', 'stage', 'plan'].includes(phase);
  const pending = isImport ? stageRun(f, { signal: c.signal }) : exportRun(f, { signal: c.signal }); await entered.promise; c.abort(PASSWORD);
  await assert.rejects(soon(pending), e => redacted(e) && (isImport && phase !== 'read' ? e.stagingMayExist === true && e.cancelled === true : e.name === 'AbortError'));
  const before = structuredClone(f.calls), progress = f.progress.length; gate.reject(Error(PASSWORD)); await nextTurn();
  assert.deepEqual(f.calls, before); assert.equal(f.progress.length, progress); assert.equal(f.calls.cleanup, 1); if (phase === 'read') assert.equal(returned, 1);
});
for (const path of ['success', 'plan failure', 'before staging']) for (const cleanup of ['success', 'failure']) {
  test(`cancel during deferred cleanup after ${path}; cleanup ${cleanup} preserves error fields and never issues automatic RPCs`, async () => {
    const h = harness(), f = fixture([1, 1, 1]), entered = deferred(), gate = deferred(), c = new AbortController();
    const staged = path !== 'before staging'; f.target = api.createActivityImportSession(TOKEN).target;
    if (!staged) f.cat.tables[2].row_hashes_sha256 = '0'.repeat(64);
    else {
      h.respond(bound()); for (const key of TABLES) h.respond(ack(f.texts[key]));
      if (path === 'plan failure') h.replies.push({ reject: Error(PASSWORD) }); else h.respond(plan(counts(), 3));
    }
    f.files.abort = async reason => { f.calls.cleanup++; assert.ok(reason instanceof Error); redacted(reason); entered.resolve(); await gate.promise; };
    const pending = stageRun(f, { signal: c.signal }); let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await soon(entered.promise);
    assert.deepEqual(h.calls.map(call => call.name), staged ? ['employee_import_activity_bind', ...TABLES.map(() => 'employee_import_activity_stage'), 'get_employee_import_activity_plan'] : []);
    assert.equal(h.replies.length, 0); assert.equal(f.calls.cleanup, 1);
    const before = h.calls.map(call => ({ ...call, args: structuredClone(call.args), signals: [...call.signals] }));
    const progress = structuredClone(f.progress), calls = structuredClone(f.calls);
    c.abort(PASSWORD); await nextTurn(); assert.equal(settled, false);
    if (cleanup === 'failure') gate.reject(Error(PASSWORD)); else gate.resolve();
    await assert.rejects(soon(pending), error => {
      redacted(error); assert.equal('plan' in error, false); assert.equal('result' in error, false);
      if (cleanup === 'failure') {
        assert.ok(error instanceof api.ActivityTransferCleanupError);
        assert.equal(error.name, 'ActivityTransferCleanupError'); assert.equal(error.cleanupRequired, true);
        assert.equal(error.stagingMayExist, staged); assert.equal('cancelled' in error, false);
      } else if (staged) {
        assert.ok(error instanceof api.ActivityImportStagingMayExistError);
        assert.equal(error.name, 'ActivityImportStagingMayExistError'); assert.equal(error.stagingMayExist, true); assert.equal(error.cancelled, true);
        assert.equal('cleanupRequired' in error, false);
        assert.match(error.message, /Server staging may exist; reconcile before rerunning/);
        assert.match(error.message, /No automatic retry, cancel, rollback, restore or close was performed/);
      } else {
        assert.equal(error.name, 'AbortError'); assert.equal('stagingMayExist' in error, false); assert.equal('cleanupRequired' in error, false);
      }
      return true;
    });
    await nextTurn(); assert.deepEqual(h.calls, before); assert.deepEqual(f.calls, calls); assert.deepEqual(f.progress, progress);
    assert.equal(h.replies.length, 0);
  });
}
test('deferred cleanup without cancellation returns every result field and does not auto-apply, verify or close', async () => {
  const h = harness(), f = fixture([1, 1, 1]), entered = deferred(), gate = deferred(); f.target = api.createActivityImportSession(TOKEN).target;
  h.respond(bound()); for (const key of TABLES) h.respond(ack(f.texts[key])); h.respond(plan(counts(), 3));
  f.files.abort = async () => { f.calls.cleanup++; entered.resolve(); await gate.promise; };
  const pending = stageRun(f); let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  await soon(entered.promise); await nextTurn(); assert.equal(settled, false);
  gate.resolve(); assert.deepEqual(await soon(pending), { plan: plan(counts(), 3), rows: 3,
    bytes: Buffer.byteLength(Object.values(f.texts).join('')), fullSiteComplete: false });
  await nextTurn(); assert.deepEqual(h.calls.map(call => call.name), ['employee_import_activity_bind', ...TABLES.map(() => 'employee_import_activity_stage'), 'get_employee_import_activity_plan']);
  assert.equal(h.replies.length, 0); assert.equal(f.calls.cleanup, 1);
});
test('pre-abort reads/writes no data but still discards isolated workspace', async () => {
  for (const run of [exportRun, stageRun]) { const f = fixture(), c = new AbortController(); c.abort(PASSWORD);
    await assert.rejects(run(f, { signal: c.signal }), e => e.name === 'AbortError' && redacted(e)); assert.equal(f.calls.open.length, 0); assert.equal(f.calls.pages.length, 0); assert.equal(f.calls.cleanup, 1); }
});
test('cleanup failure explicit non-reusable even after successful import; backend secrets never leak', async () => {
  const f = fixture(); f.source.catalog = async () => { throw Error(PASSWORD); }; f.sink.abort = async () => { throw Error(PASSWORD); };
  await assert.rejects(exportRun(f), e => e.cleanupRequired === true && redacted(e));
  const g = fixture(); g.files.abort = async () => { throw Error(PASSWORD); };
  await assert.rejects(stageRun(g), e => e.cleanupRequired === true && e.stagingMayExist === true && redacted(e));
});
test('stream reader cancellation never awaits stalled producer', async () => {
  const f = fixture(), c = new AbortController(), entered = deferred(); let cancelled = 0;
  f.files.open = () => new ReadableStream({ pull() { entered.resolve(); return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } });
  const pending = stageRun(f, { signal: c.signal }); await entered.promise; c.abort(); await assert.rejects(soon(pending), { name: 'AbortError' });
  assert.equal(cancelled, 1); assert.equal(f.calls.cleanup, 1);
});
test('factories reject malformed session/package/job UUIDs without RPC', () => {
  const h = harness();
  for (const value of [null, 'bad', TOKEN + '\n', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']) {
    assert.throws(() => api.createActivityExportSession(value, PASSWORD));
    assert.throws(() => api.createActivityImportSession(value));
  }
  h.session = SESSION + '\n';
  assert.throws(() => api.createActivityExportSession(PACKAGE, PASSWORD));
  assert.throws(() => api.createActivityImportSession(TOKEN)); assert.equal(h.calls.length, 0);
});
test('export factory lazy, explicit begin once, detached identity/catalog, explicit verify before close', async () => {
  const h = harness(), s = api.createActivityExportSession(PACKAGE, PASSWORD); assert.equal(h.reads, 1); assert.equal(h.calls.length, 0); assert.equal(s.identity(), null);
  await assert.rejects(s.source.catalog(), /not been confirmed/); await assert.rejects(s.close(), /not been confirmed/);
  const raw = { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() }; h.respond(raw); const c = await s.begin();
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_admin_password: PASSWORD, p_package_id: PACKAGE });
  c.tables[0].rows = 900; c.identity_catalog.tables[0].rows = 900; raw.catalog.tables[0].rows = 800; s.identity().jobToken = OTHER; h.session = OTHER;
  assert.equal((await s.source.catalog()).tables[0].rows, 1); assert.equal((await s.source.catalog()).identity_catalog.tables[0].rows, 1);
  await assert.rejects(s.close(), /explicitly verified/);
  h.respond(verified()); await s.source.verify(); h.respond(closed()); await s.close(); await assert.rejects(s.source.catalog(), /closed/);
  await assert.rejects(s.begin(), /cannot be retried/);
  assert.deepEqual(h.calls.map(c => c.name), ['employee_export_activity_begin', 'employee_export_activity_verify', 'employee_export_activity_close']);
  assert.ok(h.calls.slice(1).every(c => c.args.p_job_token === TOKEN && c.args.p_admin_session_token === SESSION));
});
test('export page sends UUID text after with limit 200, validates cursors; reading revokes verified close permission', async () => {
  const h = harness(), s = api.createActivityExportSession(PACKAGE, PASSWORD); h.respond({ ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() }); await s.begin();
  h.respond(verified()); await s.source.verify();
  const ndjson = line(TABLES[0], 2); h.respond({ table_key: TABLES[0], count: 1, ndjson, next_after: null, sha256: sha(ndjson) });
  await s.source.page(TABLES[0], id(1)); assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_table_key: TABLES[0], p_after: id(1), p_limit: 200 });
  await assert.rejects(s.close(), /explicitly verified/);
  const before = h.calls.length; for (const cursor of [1, '0', '9007199254740993', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']) await assert.rejects(s.source.page(TABLES[0], cursor));
  assert.equal(h.calls.length, before);
});
test('import factory uses existing token only, guards order, detaches plans/catalogs, explicitly applies/verifies', async () => {
  const h = harness(), s = api.createActivityImportSession(TOKEN); assert.deepEqual(Object.keys(s).sort(), ['target', 'plan', 'apply', 'verify'].sort());
  assert.deepEqual(Object.keys(s.target).sort(), ['bind', 'stage', 'plan'].sort()); assert.equal(h.calls.length, 0);
  await assert.rejects(s.plan(), /not been confirmed/); await assert.rejects(s.target.stage(TABLES[0], 0, line(TABLES[0], 1)), /not been confirmed/);
  await assert.rejects(s.apply(id(1), PLAN)); await assert.rejects(s.verify());
  const c = catalog(); h.respond(bound()); await s.target.bind(c); c.tables[0].rows = 500; c.identity_catalog.tables[0].rows = 500;
  h.respond(ack(line(TABLES[0], 1))); await s.target.stage(TABLES[0], 0, line(TABLES[0], 1));
  const raw = plan(); h.respond(raw); const p = await s.target.plan(); p.plan_hash = 'b'.repeat(64); p.counts.work_sessions = 500; p.running_work_sessions = 0; raw.employees = 500;
  await assert.rejects(s.apply(id(1), 'b'.repeat(64)), /conflict-free/);
  h.respond(applyReceipt()); const applied = await s.apply(id(1), PLAN); applied.counts.work_sessions = 99;
  h.respond(verifyReceipt()); await s.verify();
  assert.deepEqual(h.calls.map(c => c.name), ['employee_import_activity_bind', 'employee_import_activity_stage', 'get_employee_import_activity_plan', 'employee_import_activity_apply', 'employee_import_activity_verify']);
  assert.deepEqual(h.calls[3].args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_employee_id: id(1), p_plan_hash: PLAN });
  assert.ok(h.calls.every(c => c.args.p_job_token === TOKEN && !('p_admin_password' in c.args)));
});
test('new factory same binding/plan explicitly repeats employee apply for idempotent continuation', async () => {
  const h = harness(), first = await imported(h, true); h.respond(applyReceipt()); await first.apply(id(1), PLAN);
  const second = api.createActivityImportSession(TOKEN); h.respond({ ...bound(), repeated: true }); await second.target.bind(catalog()); h.respond(plan()); await second.plan();
  h.respond({ ...applyReceipt(), repeated: true }); assert.equal((await second.apply(id(1), PLAN)).repeated, true);
  h.respond(verifyReceipt()); await second.verify(); assert.equal(h.calls.some(c => /begin|cancel|finish|enable|close/.test(c.name)), false);
});
test('zero-history employees still bind, plan, apply and verify; totals are not inferred from history', async () => {
  const h = harness(), s = api.createActivityImportSession(TOKEN), c = catalog(Object.fromEntries(TABLES.map(key => [key, ''])), 3);
  h.respond(bound()); await s.target.bind(c); h.respond(plan(counts(0), 3)); await s.plan();
  h.respond({ ...verifyReceipt(counts(0), 3), completed_employees: 1, employee_id: id(1) }); await s.apply(id(1), PLAN);
  h.respond(verifyReceipt(counts(0), 3)); await s.verify();
});
test('mutating conflicted returned plan cannot authorize apply/verify; failed plan invalidates previous approval', async () => {
  const h = harness(), s = await imported(h); const raw = { ...plan(), can_restore: false, conflicts: ['activity_target_not_empty'] };
  h.respond(raw); const p = await s.plan(); p.can_restore = true; p.conflicts.length = 0; raw.conflicts.length = 0;
  await assert.rejects(s.apply(id(1), PLAN), /conflict-free/); await assert.rejects(s.verify(), /conflict-free/);
  h.respond(plan()); await s.plan(); h.respond({ ...plan(), employees: 2 }); await assert.rejects(s.plan(), redacted);
  await assert.rejects(s.apply(id(1), PLAN), /conflict-free/);
});
test('new staging invalidates plan; changed identity fingerprints forbidden; unknown restore blocks new staging', async () => {
  const h = harness(), s = await imported(h, true); h.respond(ack(line(TABLES[0], 1))); await s.target.stage(TABLES[0], 0, line(TABLES[0], 1));
  await assert.rejects(s.apply(id(1), PLAN), /conflict-free/);
  for (const edit of [c => { c.identity_catalog.processing_orders++; }, ...[0, 1, 2].map(i => c => { c.identity_catalog.tables[i].row_hashes_sha256 = PLAN; })]) {
    const changed = catalog(); edit(changed); await assert.rejects(s.target.bind(changed), /immutable/);
  }
  h.respond(plan()); await s.plan(); h.replies.push({ reject: Error(PASSWORD) });
  await assert.rejects(s.apply(id(1), PLAN), e => /unknown or unconfirmed/.test(e.message) && redacted(e));
  await assert.rejects(s.target.stage(TABLES[0], 0, line(TABLES[0], 1)), /restore was attempted/);
});
for (const [label, edit] of [
  ['wrong employee', r => { r.employee_id = OTHER; }], ['count exceeds catalog', r => { r.counts.work_sessions = 2; }], ['wrong total employees', r => { r.total_employees = 2; }],
]) test(`apply rejects receipt ${label}`, async () => { const h = harness(), s = await imported(h, true), r = applyReceipt(); edit(r); h.respond(r); await assert.rejects(s.apply(id(1), PLAN), redacted); });
test('verify matches complete global catalog counts, not per-employee counts', async () => {
  const h = harness(), s = await imported(h, true); const r = verifyReceipt(); r.counts.work_sessions = 0; h.respond(r);
  await assert.rejects(s.verify(), redacted); h.respond(verifyReceipt()); await s.verify();
});
const operations = {
  bind: async h => { const s = api.createActivityImportSession(TOKEN); return [signal => s.target.bind(catalog(), signal), bound()]; },
  stage: async h => { const s = await imported(h); return [signal => s.target.stage(TABLES[0], 0, line(TABLES[0], 1), signal), ack(line(TABLES[0], 1))]; },
  plan: async h => { const s = await imported(h); return [signal => s.plan(signal), plan()]; },
  apply: async h => { const s = await imported(h, true); return [signal => s.apply(id(1), PLAN, signal), applyReceipt()]; },
  verify: async h => { const s = await imported(h, true); return [signal => s.verify(signal), verifyReceipt()]; },
  exportPage: async h => { const s = api.createActivityExportSession(PACKAGE, PASSWORD); h.respond({ ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() }); await s.begin();
    const ndjson = line(TABLES[0], 1); return [signal => s.source.page(TABLES[0], null, signal), { table_key: TABLES[0], count: 1, ndjson, next_after: null, sha256: sha(ndjson) }]; },
  exportVerify: async h => { const s = api.createActivityExportSession(PACKAGE, PASSWORD); h.respond({ ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() }); await s.begin(); return [signal => s.source.verify(signal), verified()]; },
  exportClose: async h => { const s = api.createActivityExportSession(PACKAGE, PASSWORD); h.respond({ ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() }); await s.begin(); h.respond(verified()); await s.source.verify(); return [signal => s.close(signal), closed()]; },
};
for (const [name, setup] of Object.entries(operations)) {
  for (const mode of ['rpcThrow', 'promiseReject', 'backendError', 'getter', 'extra', 'invalid']) test(`${name}: ${mode} redacted, unknown outcome, single attempt, no implicit followup`, async () => {
    const h = harness(), [run, good] = await setup(h), before = h.calls.length;
    if (mode === 'rpcThrow') h.replies.push({ throw: Error(PASSWORD) });
    if (mode === 'promiseReject') h.replies.push({ reject: Error(PASSWORD) });
    if (mode === 'backendError') h.replies.push({ error: { message: PASSWORD, details: PASSWORD }, data: good });
    if (mode === 'getter') { const key = Object.keys(good)[0]; Object.defineProperty(good, key, { enumerable: true, get() { assert.fail('getter'); } }); h.respond(good); }
    if (mode === 'extra') h.respond({ ...good, leaked_password: PASSWORD });
    if (mode === 'invalid') h.respond(null);
    await assert.rejects(run(), e => /unknown or unconfirmed/.test(e.message) && redacted(e)); assert.equal(h.calls.length, before + 1); assert.equal(h.replies.length, 0);
  });
  test(`${name}: pre-abort no RPC; pending abort rejects promptly with unknown-result warning`, async () => {
    const h = harness(), [run, good] = await setup(h), pre = new AbortController(); pre.abort(PASSWORD); const before = h.calls.length;
    await assert.rejects(run(pre.signal), e => e.name === 'AbortError' && redacted(e)); assert.equal(h.calls.length, before);
    const gate = deferred(), c = new AbortController(); h.replies.push({ wait: gate.promise }); const pending = run(c.signal); await nextTurn();
    c.abort(PASSWORD); await assert.rejects(soon(pending), e => e.name === 'AbortError' && /unknown or unconfirmed/.test(e.message) && redacted(e));
    gate.resolve({ data: good }); await nextTurn(); assert.equal(h.calls.length, before + 1); assert.deepEqual(h.calls.at(-1).signals, [c.signal]);
  });
}
for (const mode of ['throw', 'reject', 'error', 'extra', 'badCatalog', 'wrongSite', 'wrongPackage', 'preAbort', 'lateAbort']) test(`export begin ${mode} clears one-use password, no leaks/retries`, async () => {
  const h = harness(), s = api.createActivityExportSession(PACKAGE, PASSWORD), c = new AbortController();
  const value = { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() };
  if (mode === 'throw') h.replies.push({ throw: Error(PASSWORD) });
  else if (mode === 'reject') h.replies.push({ reject: Error(PASSWORD) });
  else if (mode === 'error') h.replies.push({ error: { message: PASSWORD } });
  else if (mode === 'preAbort') c.abort(PASSWORD);
  else if (mode === 'lateAbort') { const gate = deferred(); h.replies.push({ wait: gate.promise }); const pending = s.begin(c.signal); await nextTurn(); c.abort(PASSWORD);
    await assert.rejects(soon(pending), e => e.name === 'AbortError' && redacted(e)); gate.resolve({ data: value }); await nextTurn(); }
  else { if (mode === 'extra') value.secret = PASSWORD; if (mode === 'badCatalog') value.catalog.tables[0].rows = -1;
    if (mode === 'wrongSite') value.site_id = OTHER; if (mode === 'wrongPackage') { value.catalog.package_id = OTHER; value.catalog.identity_catalog.package_id = OTHER; } h.respond(value); }
  if (mode !== 'lateAbort') await assert.rejects(s.begin(c.signal), redacted);
  assert.equal(s.identity(), null); const before = h.calls.length; await assert.rejects(s.begin(), /cannot be retried/); assert.equal(h.calls.length, before);
});
test('per-session exclusion covers export/import operations including catalog while pending', async () => {
  const h = harness(), s = api.createActivityExportSession(PACKAGE, PASSWORD), gate = deferred(); h.replies.push({ wait: gate.promise });
  const pending = s.begin(); await assert.rejects(s.begin(), /cannot be retried/); await assert.rejects(s.source.catalog(), /already in progress/);
  await nextTurn(); assert.equal(h.calls[0].args.p_admin_password, PASSWORD); gate.resolve({ data: { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() } }); await pending;
  const i = await imported(h), g = deferred(); h.replies.push({ wait: g.promise }); const planned = i.plan(); await nextTurn();
  for (const call of [() => i.apply(id(1), PLAN), () => i.verify(), () => i.target.bind(catalog()), () => i.target.stage(TABLES[0], 0, line(TABLES[0], 1))]) await assert.rejects(call(), /already in progress/);
  g.resolve({ data: plan() }); await planned;
});
test('API validates raw stage chunks and empty-table chunk zero before RPC', async () => {
  const h = harness(), s = await imported(h), before = h.calls.length;
  for (const [key, no, value] of [[TABLES[0], 0, ''], [TABLES[0], -1, line(TABLES[0], 1)], [TABLES[0], 500001, line(TABLES[0], 1)], [TABLES[0], 0, line(TABLES[0], 1).trimEnd()], ['bad', 0, ''],
    [TABLES[0], 0, deviceLine('{"a":1,"a":2}')], [TABLES[0], 0, deviceLine('null', 'false')], [TABLES[0], 0, deviceLine('{}', true)],
    [TABLES[0], 0, line(TABLES[0], 1).replace(',"device_info_is_sql_null":false', '')], [TABLES[0], 0, text(TABLES[0], 201)]]) await assert.rejects(s.target.stage(key, no, value));
  assert.equal(h.calls.length, before); const raw = line(TABLES[0], 1); h.respond(ack(raw)); await s.target.stage(TABLES[0], 0, raw);
  assert.equal(h.calls.at(-1).args.p_ndjson, raw);
  const e = api.createActivityImportSession(TOKEN); h.respond(bound()); await e.target.bind(catalog(Object.fromEntries(TABLES.map(key => [key, '']))));
  h.respond(ack('')); await e.target.stage(TABLES[0], 0, ''); await assert.rejects(e.target.stage(TABLES[0], 1, ''));
});
test('line/page byte boundaries include LF and UTF8, 64KiB rows split exact 256KiB pages', async () => {
  const key = TABLES[0], f = fixture([5, 0, 0]);
  f.texts[key] = Array.from({ length: 5 }, (_, i) => { const r = row(key, i + 1); r.user_agent = '';
    r.user_agent = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(r) + '\n')); return JSON.stringify(r) + '\n'; }).join('');
  f.cat = catalog(f.texts, 3); await exportRun(f); await stageRun(f);
  assert.deepEqual(f.calls.pages.filter(p => p.key === key).map(p => p.after), [null, id(4)]);
  assert.deepEqual(f.calls.stage.filter(p => p.key === key).map(p => Buffer.byteLength(p.ndjson)), [262144, 65536]);
  const exact = f.texts[key].match(/[^\n]*\n/g)[0]; api.validateActivityRow(exact, key); assert.throws(() => api.validateActivityRow(exact.replace('"user_agent":"', '"user_agent":"x'), key));
  const ndjson = 'é'.repeat(131073); assert.throws(() => api.validateActivityPage({ table_key: key, count: 1, ndjson, next_after: null, sha256: sha(ndjson) }, key, null));
});
test('input buffer reuse and sink detachment cannot corrupt digests or acknowledged byte counts', async () => {
  const f = fixture([1, 1, 1]), write = f.sink.append; f.sink.append = async (path, bytes) => { await write(path, bytes); structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); };
  assert.equal((await exportRun(f)).bytes, f.cat.tables.reduce((sum, t) => sum + t.bytes, 0));
  f.files.open = path => ({ async *[Symbol.asyncIterator]() {
    const key = TABLES.find(k => path === `data/activity-${k}.ndjson`), bytes = Buffer.from(f.texts[key]), reused = Buffer.alloc(41);
    for (let i = 0; i < bytes.length; i += 41) { const size = Math.min(41, bytes.length - i); bytes.copy(reused, 0, i, i + size); yield reused.subarray(0, size); }
  } }); f.target.bind = async () => bound(); await stageRun(f);
});
test('real isolated temporary files export exact bytes, reopen twice as streams and delete all plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'employee-activity-client-')), f = fixture([203, 203, 2]); let discarded = false;
  const filePath = path => { assert.ok(TABLES.some(key => path === `data/activity-${key}.ndjson`)); return join(directory, path.split('/')[1]); };
  const temporary = {
    async append(path, bytes) { assert.equal(discarded, false); const fd = await open(filePath(path), 'a', 0o600); try { await fd.writeFile(bytes); } finally { await fd.close(); } },
    open(path) { assert.equal(discarded, false); return new ReadableStream({ async start(controller) {
      const fd = await open(filePath(path), 'r'); try { for await (const bytes of fd.createReadStream({ highWaterMark: 97, autoClose: false })) controller.enqueue(bytes); controller.close(); }
      catch (error) { controller.error(error); } finally { await fd.close(); }
    } }); },
    async abort() { discarded = true; await rm(directory, { recursive: true, force: true }); },
  };
  try {
    const r = await api.exportActivityData(f.source, temporary); for (const entry of r.entries) assert.equal(sha(await readFile(filePath(entry.path))), entry.sha256);
    f.target.bind = async c => { assert.deepEqual(c, f.cat); return bound(); }; const imported = await api.stageActivityImport(r.catalog, temporary, f.target);
    assert.equal(imported.rows, 408); assert.equal(discarded, true); await assert.rejects(readFile(join(directory, 'activity-employee_login_history.ndjson')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('authenticated manifest binds same site/package and exactly ordered three-file catalog', () => {
  const c = catalog(), m = { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: JOB, sourceSiteId: SITE,
    createdAt: '2026-10-18T01:02:03Z', volumeIndex: 1, volumeCount: 1,
    entries: c.tables.map(t => ({ path: `data/activity-${t.key}.ndjson`, kind: 'ndjson', bytes: t.bytes, sha256: sha(text(t.key, 1)) })) };
  api.validateActivityManifest(m, c);
  for (const change of [v => { v.exportId = OTHER; }, v => { v.sourceSiteId = OTHER; }, v => { v.volumeCount = 2; }, v => { v.entries.reverse(); }, v => { v.entries[0].bytes++; }, v => { v.entries[0].path = '../history.ndjson'; }, v => { v.entries[0].sha256 = PLAN.toUpperCase(); }]) {
    const bad = structuredClone(m); change(bad); assert.throws(() => api.validateActivityManifest(bad, c));
  }
});
