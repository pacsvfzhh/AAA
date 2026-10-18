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
const PASSWORD = 'never-echo-finance-password-or-backend-text';
const PLAN = 'a'.repeat(64), TIME = '2024-02-29T12:34:56.123456+00:00';
const TABLES = ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'];
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const big = n => (9007199254740992n + BigInt(n)).toString();
const sha = value => createHash('sha256').update(value).digest('hex');
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
const counts = (n = 1) => Object.fromEntries(TABLES.map(key => [key, n]));
const plan = (totals = counts()) => ({ scope: 'employee-finance', can_restore: true, counts: totals, employees: totals.wallets,
  pending_withdrawals: { count: totals.withdrawals, amount: '12345678901234567890.12345678901234567890' }, conflicts: [], plan_hash: PLAN, ...flags() });
const verifyReceipt = (totals = counts()) => ({ success: true, scope: 'employee-finance', counts: totals,
  completed_employees: totals.wallets, total_employees: totals.wallets, verified: true, repeated: false, ...flags() });
const applyReceipt = (employee = id(1)) => ({ ...verifyReceipt(), employee_id: employee });
const verified = () => ({ verified: true, scope: 'employee-finance', full_site_complete: false });
const closed = () => ({ success: true, scope: 'employee-finance', full_site_complete: false });
const bound = () => ({ ...closed(), repeated: false });
const row = (key, n = 1) => ({
  wallets: { id: id(n), user_id: id(n), available_balance: 0, frozen_balance: null, created_at: TIME, updated_at: null },
  wallet_balance_baselines: { id: id(n), user_id: id(n), available_balance: 0, frozen_balance: 0, total_income: 0, last_ledger_id: big(n), established_at: TIME },
  wallet_ledger_entries: { id: big(n), user_id: id(1), operation_id: id(n), source_type: 'wallet_transaction', source_id: id(n), event_type: 'income',
    available_delta: 0, frozen_delta: -1, income_delta: 0, created_at: TIME },
  wallet_transactions: { id: id(n), user_id: id(1), type: 'commission', amount: 0, balance_before: -1, balance_after: 0,
    reference_id: id(n), remarks: '员工é é 𠮷', created_by: OTHER, created_at: TIME, operation_id: null },
  withdrawals: { id: id(n), user_id: id(1), amount: 0, status: ['pending', 'approved', 'rejected', 'cancelled'][n % 4],
    audit_remark: null, audited_by: null, audited_at: null, created_at: TIME, last_operation_id: null },
  wallet_reconciliation_audit: { id: big(n), user_id: id(1), available_before: 0, available_after: 0, frozen_before: -1, frozen_after: 0,
    income_before: 0, income_after: 0, pending_amount: 0, ledger_total: 0, reason: '保留原文𠮷', repaired_at: TIME },
})[key];
const line = (key, n) => JSON.stringify(row(key, n)).replace(/:0(?=[,}])/g, ':12345678901234567890.12345678901234567890') + '\n';
const text = (key, n) => Array.from({ length: n }, (_, i) => line(key, i + 1)).join('');
const nrows = value => value ? value.split('\n').length - 1 : 0;
const ack = value => ({ success: true, rows: nrows(value), bytes: Buffer.byteLength(value), sha256: sha(value), repeated: false });
const rowHash = value => sha((value.match(/[^\n]*\n/g) ?? []).map(item => sha(item)).join(''));
function identityCatalog(employees = 1) {
  return { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE,
    tables: ['accounts', 'credentials', 'orders'].map((key, index) => ({ key, rows: index === 0 ? employees : 0,
      bytes: index === 0 ? employees * 500 : 0, row_hashes_sha256: sha('') })), processing_orders: 0, full_site_complete: false };
}
function catalog(texts = Object.fromEntries(TABLES.map(key => [key, text(key, 1)]))) {
  return { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE, identity_catalog: identityCatalog(nrows(texts.wallets)),
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
  stdin: { contents: `export * from './src/lib/employeeTransfer/financeTransfer.ts';
    export * from './src/lib/employeeTransfer/financeApi.ts'; export { setHarness } from 'finance-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'finance-transport-only', setup(builder) {
    builder.onResolve({ filter: /^(?:finance-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/financeApi.ts`);
      return { path: args.path, namespace: 'finance-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'finance-test' }, ({ path }) => {
      if (path === 'finance-test:state') return { contents: 'let h; export const setHarness = v => {h=v;}; export const current = () => h;' };
      if (path === '../auth') return { contents: `import {current} from 'finance-test:state'; export function getAdminFinancialSessionToken() {const h=current();h.reads++;return h.session;}` };
      return { contents: `import {current} from 'finance-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
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
  const s = api.createFinanceImportSession(TOKEN); h.respond(bound()); await s.target.bind(catalog());
  if (planned) { h.respond(plan()); await s.plan(); } return s;
}
function fixture(sizes = [2, 2, 405, 405, 405, 405]) {
  const texts = Object.fromEntries(TABLES.map((key, index) => [key, text(key, sizes[index])]));
  const cat = catalog(texts), calls = { pages: [], writes: [], open: [], bind: 0, stage: [], plan: 0, verify: 0, cleanup: 0 }, events = [], progress = [], stored = new Map();
  const f = { texts, cat, calls, events, progress, stored };
  f.source = {
    async catalog() { return f.cat; },
    async page(key, after) {
      calls.pages.push({ key, after });
      const all = texts[key].match(/[^\n]*\n/g) ?? [];
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
      calls.open.push(path); const key = TABLES.find(key => path === `data/finance-${key}.ndjson`); assert.ok(key);
      const bytes = Buffer.from(f.texts[key]);
      return { async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 97) yield bytes.subarray(i, i + 97); events.push(`eof:${key}`); } };
    },
    async abort() { calls.cleanup++; },
  };
  f.target = {
    async bind(input) { assert.deepEqual(input, f.cat); calls.bind++; assert.deepEqual(events.slice(0, 6), TABLES.map(key => `eof:${key}`)); return bound(); },
    async stage(key, chunkNo, ndjson) { calls.stage.push({ key, chunkNo, ndjson }); return ack(ndjson); },
    async plan() { calls.plan++; return plan(Object.fromEntries(f.cat.tables.map(t => [t.key, t.rows]))); },
  };
  return f;
}
const exportRun = (f, options = {}) => api.exportFinanceData(f.source, f.sink, { onProgress: p => f.progress.push(p), ...options });
const stageRun = (f, options = {}) => api.stageFinanceImport(f.cat, f.files, f.target, { onProgress: p => f.progress.push(p), ...options });
const redacted = error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(PASSWORD), false); assert.equal('cause' in error, false); return true; };

test('real lightweight bundle uses finance/identity/checks/SHA only, no runtime ZIP, crypto, old API or node_modules', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['financeTransfer', 'financeApi', 'identityTransfer', 'dispatchTransfer', 'sha256']) assert.ok(inputs.some(path => path.endsWith(`/${name}.ts`)));
  assert.equal(inputs.some(path => /node_modules|\/(?:api|container|crypto|manifest|dispatchBackup|dispatchImport|replacementBackup)\.ts$/.test(path)), false);
  assert.equal(api.FINANCE_PROTOCOL, 'employee-finance-v1'); assert.deepEqual(api.FINANCE_TABLE_KEYS, TABLES);
  assert.deepEqual(api.FINANCE_TRANSFER_LIMITS, { maxRows: 500000, maxTableBytes: 268435456, maxTotalBytes: 1073741824,
    maxLineBytes: 65536, maxPageRows: 200, maxPageBytes: 262144, maxChunks: 500001, maxInputBytes: 1048576 });
});
for (const [label, change] of [
  ['version', c => { c.version = 2; }], ['scope', c => { c.scope = 'employee-identity'; }], ['extra', c => { c.password = PASSWORD; }],
  ['full site', c => { c.full_site_complete = true; }], ['UUID', c => { c.site_id = 'bad'; }], ['missing package', c => { delete c.package_id; }],
  ['uppercase UUID', c => { c.package_id = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'; }], ['order', c => { c.tables.reverse(); }],
  ['missing table', c => { c.tables.pop(); }], ['unknown table', c => { c.tables[0].key = 'wallet'; }], ['extra table field', c => { c.tables[0].x = 1; }],
  ['row bound', c => { c.tables[0].rows = 500001; }], ['negative rows', c => { c.tables[0].rows = -1; }], ['fractional rows', c => { c.tables[0].rows = 0.5; }],
  ['table bytes', c => { c.tables[0].bytes = 268435457; }], ['empty mismatch', c => { c.tables[0].bytes = 0; }],
  ['hash', c => { c.tables[0].row_hashes_sha256 = 'A'.repeat(64); }], ['total bytes', c => { c.tables.forEach(t => { t.bytes = 268435456; }); }],
  ['identity site', c => { c.identity_catalog.site_id = OTHER; }], ['identity package', c => { c.identity_catalog.package_id = OTHER; }],
  ['identity shape', c => { c.identity_catalog.processing_orders = -1; }], ['sparse array', c => { delete c.tables[1]; }],
  ['iterator injection', c => { c.tables[Symbol.iterator] = () => assert.fail('iterator'); }], ['array extra', c => { c.tables.extra = true; }],
]) test(`catalog rejects ${label}`, () => { const c = catalog(); change(c); assert.throws(() => api.validateFinanceCatalog(c)); });
test('catalog accepts exact 1GiB total and 500000-row bounds; nested identity detached', () => {
  const c = catalog(); c.tables.forEach((t, i) => { t.rows = i < 4 ? 500000 : 0; t.bytes = i < 4 ? 268435456 : 0; });
  const copy = api.validateFinanceCatalog(c); assert.deepEqual(copy, c); copy.identity_catalog.tables[0].rows = 99; copy.tables[0].rows = 1;
  assert.equal(c.tables[0].rows, 500000); assert.equal(c.identity_catalog.tables[0].rows, 1);
});
for (const [label, make, validate] of [
  ['catalog', catalog, api.validateFinanceCatalog], ['plan', plan, api.validateFinancePlan],
  ['apply receipt', applyReceipt, api.validateFinanceApplyReceipt], ['verify receipt', verifyReceipt, api.validateFinanceVerifyReceipt],
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
for (const reason of ['financial_target_not_empty', 'financial_uuid_collision', 'financial_unique_collision', 'unmapped_administrator', 'inconsistent_source_finance', 'source_employee_missing']) {
  test(`plan accepts exact conflict ${reason}`, () => { const p = plan(); p.can_restore = false; p.conflicts = [reason]; assert.deepEqual(api.validateFinancePlan(p), p); });
}
for (const [label, edit] of [
  ['false conflictfree', p => { p.can_restore = false; }], ['fake restore', p => { p.conflicts = ['source_employee_missing']; }],
  ['unknown reason', p => { p.can_restore = false; p.conflicts = ['backend raw text']; }], ['object conflict', p => { p.can_restore = false; p.conflicts = [{ reason: 'source_employee_missing' }]; }],
  ['201 reasons', p => { p.can_restore = false; p.conflicts = Array(201).fill('source_employee_missing'); }], ['wallet != employees', p => { p.employees = 0; }],
  ['employee overflow', p => { p.employees = 500001; }], ['extra counts', p => { p.counts.x = 0; }], ['count overflow', p => { p.counts.withdrawals = 500001; }],
  ['hash', p => { p.plan_hash = 'bad'; }], ['pending overflow', p => { p.pending_withdrawals.count = 500001; }],
  ['pending negative', p => { p.pending_withdrawals.count = -1; }], ['pending extra', p => { p.pending_withdrawals.private = PASSWORD; }],
  ['conflict accessor', p => { p.conflicts = [null]; Object.defineProperty(p.conflicts, 0, { enumerable: true, get() { assert.fail('getter'); } }); }],
]) test(`plan rejects ${label}`, () => { const p = plan(); edit(p); assert.throws(() => api.validateFinancePlan(p)); });
for (const amount of ['-1', '+1', '.1', '1.', '01', '1e2', 'Infinity', 'NaN', ' 1', '', '1\n', 1, null]) {
  test(`plan rejects noncanonical/non-string amount ${JSON.stringify(amount)}`, () => { const p = plan(); p.pending_withdrawals.amount = amount; assert.throws(() => api.validateFinancePlan(p)); });
}
test('plan accepts zero, arbitrary precise nonnegative decimal and exact max 200 conflicts', () => {
  for (const amount of ['0', '0.0000', '1234567890123456789012345678901234567890.12345678901234567890']) {
    const p = plan(counts(500000)); p.pending_withdrawals.amount = amount; p.can_restore = false; p.conflicts = Array(200).fill('source_employee_missing');
    assert.deepEqual(api.validateFinancePlan(p), p);
  }
});
for (const field of Object.keys(flags())) for (const [label, make, check] of [
  ['plan', plan, api.validateFinancePlan], ['apply', applyReceipt, api.validateFinanceApplyReceipt], ['verify', verifyReceipt, api.validateFinanceVerifyReceipt],
]) test(`${label} rejects unsafe flag ${field}`, () => { const r = make(); r[field] = !r[field]; assert.throws(() => check(r)); });
for (const [label, edit] of [
  ['false success', r => { r.success = false; }], ['scope', r => { r.scope = 'dispatch-dependencies'; }], ['extra', r => { r.secret = PASSWORD; }],
  ['unverified', r => { r.verified = false; }], ['nonboolean verified', r => { r.verified = 1; }], ['repeated', r => { r.repeated = null; }],
  ['count overflow', r => { r.counts.wallet_ledger_entries = 500001; }], ['negative count', r => { r.counts.wallets = -1; }],
  ['fractional count', r => { r.counts.wallet_transactions = 1.1; }], ['missing count', r => { delete r.counts.withdrawals; }],
  ['completed over total', r => { r.completed_employees = 2; }], ['total overflow', r => { r.total_employees = 500001; }],
]) for (const [kind, make, check] of [['apply', applyReceipt, api.validateFinanceApplyReceipt], ['verify', verifyReceipt, api.validateFinanceVerifyReceipt]]) {
  test(`${kind} receipt rejects ${label}`, () => { const r = make(); edit(r); assert.throws(() => check(r)); });
}
test('apply/verify exact shape differs, verify must be complete, empty verification allowed', () => {
  assert.throws(() => api.validateFinanceApplyReceipt(verifyReceipt())); assert.throws(() => api.validateFinanceVerifyReceipt(applyReceipt()));
  for (const employee of [null, 'bad', 1]) assert.throws(() => api.validateFinanceApplyReceipt({ ...applyReceipt(), employee_id: employee }));
  assert.throws(() => api.validateFinanceApplyReceipt({ ...applyReceipt(), completed_employees: 0 }));
  assert.throws(() => api.validateFinanceVerifyReceipt({ ...verifyReceipt(), completed_employees: 0 }));
  assert.deepEqual(api.validateFinanceVerifyReceipt(verifyReceipt(counts(0))), verifyReceipt(counts(0)));
  assert.deepEqual(api.validateFinanceVerifyReceipt(verifyReceipt(counts(500000))), verifyReceipt(counts(500000)));
});
for (const key of TABLES) {
  test(`${key} preserves exact actual columns, nullable values, original numeric and UTC microseconds`, () => { assert.equal(api.validateFinanceRow(line(key, 1), key), row(key).id); });
  for (const [label, edit] of [
    ['unknown field', r => { r.extra = PASSWORD; }], ['missing field', r => { delete r.user_id; }], ['bad user', r => { r.user_id = 'bad'; }],
    ['null user', r => { r.user_id = null; }], ['bad id', r => { r.id = 'bad'; }], ['null id', r => { r.id = null; }],
    ['duplicate key', null], ['escaped duplicate key', null], ['unpaired surrogate', r => { r.user_id = '\ud800'; }],
  ]) test(`${key} rejects ${label}`, () => {
    const r = row(key); if (edit) edit(r); let value = JSON.stringify(r);
    if (label === 'duplicate key') value = value.replace('{', `{"user_id":"${id(1)}",`);
    if (label === 'escaped duplicate key') value = value.replace('{', `{"\\u0075ser_id":"${id(1)}",`);
    assert.throws(() => api.validateFinanceRow(value, key));
  });
  for (const [field, value] of Object.entries(row(key))) {
    test(`${key}.${field} rejects wrong non-null type`, () => {
      const r = row(key); r[field] = typeof value === 'number' ? '1' : typeof value === 'string' ? {} : [];
      assert.throws(() => api.validateFinanceRow(JSON.stringify(r), key));
    });
    if (typeof value === 'number') for (const invalidNumber of ['1e400', '-1e400', 'NaN', 'Infinity']) test(`${key}.${field} rejects ${invalidNumber}`, () => {
      const raw = JSON.stringify(row(key)).replace(new RegExp(`"${field}":-?[0-9]+`), `"${field}":${invalidNumber}`);
      assert.throws(() => api.validateFinanceRow(raw, key));
    });
    if (typeof value === 'string' && value === TIME) for (const invalidTime of [
      '2024-02-30T00:00:00Z', '1900-02-29T00:00:00Z', '0000-01-01T00:00:00Z', '2024-01-01T24:00:00Z',
      '2024-01-01T00:00:60Z', '2024-01-01', '2024-01-01T00:00:00', '2024-01-01T00:00:00.1234567Z', '2024-01-01T00:00:00+08:00',
    ]) test(`${key}.${field} rejects incomplete/non-UTC/invalid time ${invalidTime}`, () => {
      const r = row(key); r[field] = invalidTime; assert.throws(() => api.validateFinanceRow(JSON.stringify(r), key));
    });
  }
}
for (const [key, fields] of [
  ['wallets', ['available_balance', 'frozen_balance', 'created_at', 'updated_at']],
  ['wallet_transactions', ['reference_id', 'remarks', 'created_by', 'created_at', 'operation_id']],
  ['withdrawals', ['audit_remark', 'audited_by', 'audited_at', 'created_at', 'last_operation_id']],
]) test(`${key} accepts explicit NULL in every nullable field, but never omission`, () => {
  const r = row(key); fields.forEach(field => { r[field] = null; }); api.validateFinanceRow(JSON.stringify(r), key);
  fields.forEach(field => { const missing = { ...r }; delete missing[field]; assert.throws(() => api.validateFinanceRow(JSON.stringify(missing), key)); });
});
for (const key of ['wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_reconciliation_audit']) {
  test(`${key} every field is required non-NULL`, () => { for (const field of Object.keys(row(key))) { const r = row(key); r[field] = null; assert.throws(() => api.validateFinanceRow(JSON.stringify(r), key)); } });
}
for (const key of ['wallets', 'wallet_balance_baselines']) test(`${key} synthetic id MUST equal employee UUID`, () => {
  const r = row(key); r.id = OTHER; assert.throws(() => api.validateFinanceRow(JSON.stringify(r), key));
});
for (const key of ['wallet_ledger_entries', 'wallet_reconciliation_audit', 'wallet_balance_baselines']) {
  const field = key === 'wallet_balance_baselines' ? 'last_ledger_id' : 'id';
  for (const value of ['-1', '+1', '01', '1.0', '1e2', '9223372036854775808', '999999999999999999999', ' 1', 9007199254740992, null]) {
    test(`${key}.${field} rejects noncanonical/out-of-range bigint ${JSON.stringify(value)}`, () => { const r = row(key); r[field] = value; assert.throws(() => api.validateFinanceRow(JSON.stringify(r), key)); });
  }
  test(`${key}.${field} accepts >2^53 and 2^63-1 exactly, zero only baseline`, () => {
    for (const value of ['9007199254740993', '9223372036854775807', '0']) {
      const r = row(key); r[field] = value;
      if (value === '0' && key !== 'wallet_balance_baselines') assert.throws(() => api.validateFinanceRow(JSON.stringify(r), key));
      else api.validateFinanceRow(JSON.stringify(r), key);
    }
  });
}
test('source/status enum, nullable UUID, text unicode and finite-only amount checks are strict', () => {
  for (const type of ['wallet_transaction', 'withdrawal']) { const r = row('wallet_ledger_entries'); r.source_type = type; api.validateFinanceRow(JSON.stringify(r), 'wallet_ledger_entries'); }
  for (const [key, field, value] of [
    ['wallet_ledger_entries', 'source_type', 'other'], ['withdrawals', 'status', 'paid'], ['wallet_transactions', 'reference_id', 'not-uuid'],
    ['wallet_transactions', 'remarks', '\u0000'], ['wallet_transactions', 'remarks', '\udc00'], ['withdrawals', 'audited_by', 'bad'],
  ]) { const r = row(key); r[field] = value; assert.throws(() => api.validateFinanceRow(JSON.stringify(r), key)); }
  const raw = line('wallet_transactions', 1).replace('12345678901234567890.12345678901234567890', '-1e-100');
  api.validateFinanceRow(raw, 'wallet_transactions'); // SQL, not this shape check, owns scale and business constraints.
});
for (const key of ['wallet_ledger_entries', 'wallet_reconciliation_audit']) {
  test(`${key} bigint order crosses decimal lengths and adjacent >2^53 without coercion`, () => {
    const values = ['9', '10', '99', '100', '9007199254740992', '9007199254740993', '9223372036854775807'];
    const ndjson = values.map(value => JSON.stringify({ ...row(key), id: value }) + '\n').join('');
    const p = { table_key: key, count: values.length, ndjson, next_after: values.at(-1), sha256: sha(ndjson) };
    assert.equal(api.validateFinancePage(p, key, '8').next_after, values.at(-1));
    for (const after of ['9', values.at(-1), '0', 9]) assert.throws(() => api.validateFinancePage(p, key, after));
    const reverse = ndjson.match(/[^\n]*\n/g).reverse().join(''); assert.throws(() => api.validateFinancePage({ ...p, ndjson: reverse, sha256: sha(reverse) }, key, null));
    assert.throws(() => api.validateFinancePage({ ...p, next_after: '100' }, key, null));
  });
}
test('streamed export preserves bigint cursors, all original numeric bytes, file hashes and bounded pages', async () => {
  const f = fixture(), r = await exportRun(f); assert.equal(r.rows, 1624); assert.equal(f.calls.verify, 1); assert.equal(f.calls.cleanup, 0);
  for (const key of ['wallet_ledger_entries', 'wallet_reconciliation_audit']) assert.deepEqual(f.calls.pages.filter(p => p.key === key).map(p => p.after), [null, big(200), big(400)]);
  assert.deepEqual(f.calls.pages.filter(p => p.key === 'wallet_transactions').map(p => p.after), [null, id(200), id(400)]);
  for (const key of TABLES) {
    const path = `data/finance-${key}.ndjson`; assert.deepEqual(f.stored.get(path), Buffer.from(f.texts[key]));
    assert.deepEqual(r.entries.find(e => e.path === path), { path, kind: 'ndjson', bytes: Buffer.byteLength(f.texts[key]), sha256: sha(f.texts[key]) });
  }
  assert.ok(f.progress.every(p => p.fullSiteComplete === false));
});
for (const [label, change] of [
  ['hash', p => { p.sha256 = 'b'.repeat(64); }], ['count', p => { p.count++; }], ['table', p => { p.table_key = 'withdrawals'; }],
  ['cursor', p => { p.next_after = id(99); }], ['missing LF', p => { p.ndjson = p.ndjson.trimEnd(); p.sha256 = sha(p.ndjson); }],
  ['bytes', p => { p.ndjson = 'x'.repeat(262145); }], ['rows over', p => { p.count = 201; }], ['extra', p => { p.secret = PASSWORD; }],
  ['unordered', p => { p.ndjson = p.ndjson.match(/[^\n]*\n/g).reverse().join(''); p.sha256 = sha(p.ndjson); }],
]) test(`export rejects page ${label}, cleans and does not verify or count`, async () => {
  const f = fixture(), page = f.source.page; f.source.page = async (...args) => { const p = await page(...args); change(p); return p; };
  await assert.rejects(exportRun(f), redacted); assert.equal(f.calls.cleanup, 1); assert.equal(f.calls.verify, 0); assert.equal(f.progress.length, 0);
});
for (const label of ['table hash', 'rows', 'bytes', 'verify', 'write', 'callback']) test(`export ${label} failure discards all plaintext`, async () => {
  const f = fixture();
  if (label === 'table hash') f.cat.tables[5].row_hashes_sha256 = '0'.repeat(64);
  if (label === 'rows') f.cat.tables[5].rows++;
  if (label === 'bytes') f.cat.tables[5].bytes++;
  if (label === 'verify') f.source.verify = async () => ({ ...verified(), verified: false });
  if (label === 'write') f.sink.append = async () => { throw Error(PASSWORD); };
  await assert.rejects(exportRun(f, label === 'callback' ? { onProgress() { throw Error(PASSWORD); } } : {}), redacted); assert.equal(f.calls.cleanup, 1);
});
test('two-pass import finishes ALL files before bind, then stages original bounded pages and obtains plan only', async () => {
  const f = fixture(), r = await stageRun(f); assert.equal(r.rows, 1624); assert.equal(f.calls.bind, 1); assert.equal(f.calls.plan, 1); assert.equal(f.calls.cleanup, 1);
  assert.deepEqual(f.calls.open, [...TABLES, ...TABLES].map(key => `data/finance-${key}.ndjson`));
  for (const key of TABLES) assert.equal(f.calls.stage.filter(p => p.key === key).map(p => p.ndjson).join(''), f.texts[key]);
  assert.deepEqual(f.calls.stage.filter(p => p.key === 'wallet_ledger_entries').map(p => p.chunkNo), [0, 1, 2]);
  assert.equal(r.fullSiteComplete, false); assert.equal(r.plan.maintenance, true);
});
test('empty six-table source still stages exactly one acknowledged empty chunk per table', async () => {
  const f = fixture([0, 0, 0, 0, 0, 0]), r = await stageRun(f); assert.equal(r.rows, 0);
  assert.deepEqual(f.calls.stage, TABLES.map(key => ({ key, chunkNo: 0, ndjson: '' }))); assert.equal(f.calls.cleanup, 1);
});
for (const label of ['last hash', 'invalid UTF8', 'BOM', 'missing LF', 'input type', 'input size', 'throwing stream', 'unsorted UUID', 'unsorted bigint', 'duplicate key', 'overflow numeric']) {
  test(`import ${label} fails before bind and cleans once`, async () => {
    const f = fixture();
    if (label === 'last hash') f.cat.tables[5].row_hashes_sha256 = '0'.repeat(64);
    if (label === 'missing LF') f.texts.withdrawals = f.texts.withdrawals.trimEnd();
    if (label === 'unsorted UUID') f.texts.wallets = f.texts.wallets.match(/[^\n]*\n/g).reverse().join('');
    if (label === 'unsorted bigint') f.texts.wallet_ledger_entries = f.texts.wallet_ledger_entries.match(/[^\n]*\n/g).reverse().join('');
    if (label === 'duplicate key') f.texts.wallets = f.texts.wallets.replace('{', `{"user_id":"${id(1)}",`);
    if (label === 'overflow numeric') f.texts.wallets = f.texts.wallets.replace('12345678901234567890.12345678901234567890', '1e400');
    if (['invalid UTF8', 'BOM', 'input type', 'input size', 'throwing stream'].includes(label)) f.files.open = () => ({ async *[Symbol.asyncIterator]() {
      if (label === 'throwing stream') throw Error(PASSWORD);
      yield label === 'invalid UTF8' ? Uint8Array.from([0xc3, 0x28]) : label === 'BOM' ? Buffer.from('\ufeff' + f.texts.wallets) : label === 'input type' ? 'bad' : new Uint8Array(1048577);
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
test('second-pass same-length amount drift is detected despite correct first pass, cleanup does not claim rollback', async () => {
  const f = fixture(), bind = f.target.bind; f.target.bind = async c => { const b = await bind(c); f.texts.wallet_reconciliation_audit = f.texts.wallet_reconciliation_audit.replace('12345678901234567890.', '22345678901234567890.'); return b; };
  await assert.rejects(stageRun(f), e => e.stagingMayExist === true && redacted(e)); assert.ok(f.calls.stage.length > 0); assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
});
test('plan mismatched counts fail and conflicted matching plans never auto-apply', async () => {
  const f = fixture(); f.target.plan = async () => plan(); await assert.rejects(stageRun(f), e => e.stagingMayExist === true);
  const g = fixture([1, 1, 1, 1, 1, 1]); g.target.plan = async () => ({ ...plan(), can_restore: false, conflicts: ['financial_target_not_empty'] });
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
  const f = fixture([1, 1, 1, 1, 1, 1]), entered = deferred(), gate = deferred(), c = new AbortController();
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
test('pre-abort reads/writes no data but still discards isolated workspace', async () => {
  for (const run of [exportRun, stageRun]) { const f = fixture(), c = new AbortController(); c.abort(PASSWORD);
    await assert.rejects(run(f, { signal: c.signal }), e => e.name === 'AbortError' && redacted(e)); assert.equal(f.calls.open.length, 0); assert.equal(f.calls.pages.length, 0); assert.equal(f.calls.cleanup, 1); }
});
test('cleanup failure is explicit non-reusable, including after successful import; backend secrets never leak', async () => {
  const f = fixture(); f.source.catalog = async () => { throw Error(PASSWORD); }; f.sink.abort = async () => { throw Error(PASSWORD); };
  await assert.rejects(exportRun(f), e => e.cleanupRequired === true && redacted(e));
  const g = fixture(); g.files.abort = async () => { throw Error(PASSWORD); };
  await assert.rejects(stageRun(g), e => e.cleanupRequired === true && e.stagingMayExist === true && redacted(e));
});
test('stream reader cancellation never awaits a stalled producer', async () => {
  const f = fixture(), c = new AbortController(), entered = deferred(); let cancelled = 0;
  f.files.open = () => new ReadableStream({ pull() { entered.resolve(); return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } });
  const pending = stageRun(f, { signal: c.signal }); await entered.promise; c.abort(); await assert.rejects(soon(pending), { name: 'AbortError' });
  assert.equal(cancelled, 1); assert.equal(f.calls.cleanup, 1);
});
test('export factory is lazy, explicit begin once, detached identity/catalog, explicit verify before close', async () => {
  const h = harness(), s = api.createFinanceExportSession(PACKAGE, PASSWORD); assert.equal(h.reads, 1); assert.equal(h.calls.length, 0); assert.equal(s.identity(), null);
  await assert.rejects(s.source.catalog(), /not been confirmed/); await assert.rejects(s.close(), /not been confirmed/);
  const raw = { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() }; h.respond(raw); const c = await s.begin();
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_admin_password: PASSWORD, p_package_id: PACKAGE });
  c.tables[0].rows = 900; c.identity_catalog.tables[0].rows = 900; raw.catalog.tables[0].rows = 800; s.identity().jobToken = OTHER; h.session = OTHER;
  assert.equal((await s.source.catalog()).tables[0].rows, 1); assert.equal((await s.source.catalog()).identity_catalog.tables[0].rows, 1);
  await assert.rejects(s.close(), /explicitly verified/);
  h.respond(verified()); await s.source.verify(); h.respond(closed()); await s.close(); await assert.rejects(s.source.catalog(), /closed/);
  await assert.rejects(s.begin(), /cannot be retried/);
  assert.deepEqual(h.calls.map(c => c.name), ['employee_export_finance_begin', 'employee_export_finance_verify', 'employee_export_finance_close']);
  assert.ok(h.calls.slice(1).every(c => c.args.p_job_token === TOKEN && c.args.p_admin_session_token === SESSION));
});
test('export page sends bigint after as original text, not UUID/number, validates outgoing cursors before RPC', async () => {
  const h = harness(), s = api.createFinanceExportSession(PACKAGE, PASSWORD); h.respond({ ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() }); await s.begin();
  const ndjson = line('wallet_ledger_entries', 2); h.respond({ table_key: 'wallet_ledger_entries', count: 1, ndjson, next_after: null, sha256: sha(ndjson) });
  await s.source.page('wallet_ledger_entries', big(1)); assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_table_key: 'wallet_ledger_entries', p_after: big(1), p_limit: 200 });
  const before = h.calls.length; for (const cursor of [Number(big(1)), '0', '9223372036854775808', OTHER]) await assert.rejects(s.source.page('wallet_ledger_entries', cursor));
  assert.equal(h.calls.length, before);
});
test('import factory uses existing token only, guards order, detaches nested plans/catalogs and explicitly applies/verifies', async () => {
  const h = harness(), s = api.createFinanceImportSession(TOKEN); assert.deepEqual(Object.keys(s).sort(), ['target', 'plan', 'apply', 'verify'].sort());
  assert.deepEqual(Object.keys(s.target).sort(), ['bind', 'stage', 'plan'].sort()); assert.equal(h.calls.length, 0);
  await assert.rejects(s.plan(), /not been confirmed/); await assert.rejects(s.target.stage('wallets', 0, line('wallets', 1)), /not been confirmed/);
  await assert.rejects(s.apply(id(1), PLAN)); await assert.rejects(s.verify());
  const c = catalog(); h.respond(bound()); await s.target.bind(c); c.tables[0].rows = 500; c.identity_catalog.tables[0].rows = 500;
  h.respond(ack(line('wallets', 1))); await s.target.stage('wallets', 0, line('wallets', 1));
  const raw = plan(); h.respond(raw); const p = await s.target.plan(); p.plan_hash = 'b'.repeat(64); p.counts.wallets = 500; p.pending_withdrawals.amount = '0'; raw.employees = 500;
  await assert.rejects(s.apply(id(1), 'b'.repeat(64)), /conflict-free/);
  h.respond(applyReceipt()); await s.apply(id(1), PLAN); h.respond(verifyReceipt()); await s.verify();
  assert.deepEqual(h.calls.map(c => c.name), ['employee_import_finance_bind', 'employee_import_finance_stage', 'get_employee_import_finance_plan', 'employee_import_finance_apply', 'employee_import_finance_verify']);
  assert.deepEqual(h.calls[3].args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_employee_id: id(1), p_plan_hash: PLAN });
  assert.ok(h.calls.every(c => c.args.p_job_token === TOKEN && !('p_admin_password' in c.args)));
});
test('new factory binds same catalog, obtains plan and explicitly repeats employee apply for idempotent continuation', async () => {
  const h = harness(), first = await imported(h, true); h.respond(applyReceipt()); await first.apply(id(1), PLAN);
  const second = api.createFinanceImportSession(TOKEN); h.respond({ ...bound(), repeated: true }); await second.target.bind(catalog()); h.respond(plan()); await second.plan();
  h.respond({ ...applyReceipt(), repeated: true }); assert.equal((await second.apply(id(1), PLAN)).repeated, true);
  h.respond(verifyReceipt()); await second.verify(); assert.equal(h.calls.some(c => /begin|cancel|finish/.test(c.name)), false);
});
test('mutating a conflicted returned plan cannot authorize apply or verify; failed fresh plan invalidates previous approval', async () => {
  const h = harness(), s = await imported(h); const raw = { ...plan(), can_restore: false, conflicts: ['financial_target_not_empty'] };
  h.respond(raw); const p = await s.plan(); p.can_restore = true; p.conflicts.length = 0; raw.conflicts.length = 0;
  await assert.rejects(s.apply(id(1), PLAN), /conflict-free/); await assert.rejects(s.verify(), /conflict-free/);
  h.respond(plan()); await s.plan(); h.respond({ ...plan(), employees: 2 }); await assert.rejects(s.plan(), redacted);
  await assert.rejects(s.apply(id(1), PLAN), /conflict-free/);
});
test('new staging invalidates plan, changed catalog is forbidden, restore attempt blocks further staging even on unknown result', async () => {
  const h = harness(), s = await imported(h, true); h.respond(ack(line('wallets', 1))); await s.target.stage('wallets', 0, line('wallets', 1));
  await assert.rejects(s.apply(id(1), PLAN), /conflict-free/); const changed = catalog(); changed.identity_catalog.processing_orders++;
  await assert.rejects(s.target.bind(changed), /immutable/); h.respond(plan()); await s.plan();
  h.replies.push({ reject: Error(PASSWORD) }); await assert.rejects(s.apply(id(1), PLAN), e => /unknown or unconfirmed/.test(e.message) && redacted(e));
  await assert.rejects(s.target.stage('wallets', 0, line('wallets', 1)), /restore was attempted/);
});
for (const [label, edit] of [
  ['wrong employee', r => { r.employee_id = OTHER; }], ['count exceeds catalog', r => { r.counts.wallet_ledger_entries = 2; }],
  ['wrong total employees', r => { r.total_employees = 2; }],
]) test(`apply rejects receipt ${label}`, async () => { const h = harness(), s = await imported(h, true), r = applyReceipt(); edit(r); h.respond(r); await assert.rejects(s.apply(id(1), PLAN), redacted); });
test('verify matches complete global catalog counts, not per-employee counts', async () => {
  const h = harness(), s = await imported(h, true); const r = verifyReceipt(); r.counts.wallet_ledger_entries = 0; h.respond(r);
  await assert.rejects(s.verify(), redacted); h.respond(verifyReceipt()); await s.verify();
});
const operations = {
  bind: async h => { const s = api.createFinanceImportSession(TOKEN); return [signal => s.target.bind(catalog(), signal), bound()]; },
  stage: async h => { const s = await imported(h); return [signal => s.target.stage('wallets', 0, line('wallets', 1), signal), ack(line('wallets', 1))]; },
  plan: async h => { const s = await imported(h); return [signal => s.plan(signal), plan()]; },
  apply: async h => { const s = await imported(h, true); return [signal => s.apply(id(1), PLAN, signal), applyReceipt()]; },
  verify: async h => { const s = await imported(h, true); return [signal => s.verify(signal), verifyReceipt()]; },
};
for (const [name, setup] of Object.entries(operations)) {
  for (const mode of ['rpcThrow', 'promiseReject', 'backendError', 'getter', 'extra', 'falseSuccess']) test(`${name}: ${mode} redacted, outcome unknown, single attempt and no implicit followup`, async () => {
    const h = harness(), [run, good] = await setup(h), before = h.calls.length;
    if (mode === 'rpcThrow') h.replies.push({ throw: Error(PASSWORD) });
    if (mode === 'promiseReject') h.replies.push({ reject: Error(PASSWORD) });
    if (mode === 'backendError') h.replies.push({ error: { message: PASSWORD, details: PASSWORD }, data: good });
    if (mode === 'getter') { const key = Object.keys(good)[0]; Object.defineProperty(good, key, { enumerable: true, get() { assert.fail('getter'); } }); h.respond(good); }
    if (mode === 'extra') h.respond({ ...good, leaked_password: PASSWORD });
    if (mode === 'falseSuccess') h.respond({ ...good, ...(name === 'plan' ? { full_site_complete: true } : { success: false }) });
    await assert.rejects(run(), e => /unknown or unconfirmed/.test(e.message) && redacted(e)); assert.equal(h.calls.length, before + 1); assert.equal(h.replies.length, 0);
  });
  test(`${name}: pre-abort makes no RPC, abort of pending request rejects promptly with unknown-result warning`, async () => {
    const h = harness(), [run, good] = await setup(h), pre = new AbortController(); pre.abort(PASSWORD); const before = h.calls.length;
    await assert.rejects(run(pre.signal), e => e.name === 'AbortError' && redacted(e)); assert.equal(h.calls.length, before);
    const gate = deferred(), c = new AbortController(); h.replies.push({ wait: gate.promise }); const pending = run(c.signal); await nextTurn();
    c.abort(PASSWORD); await assert.rejects(soon(pending), e => e.name === 'AbortError' && /unknown or unconfirmed/.test(e.message) && redacted(e));
    gate.resolve({ data: good }); await nextTurn(); assert.equal(h.calls.length, before + 1); assert.deepEqual(h.calls.at(-1).signals, [c.signal]);
  });
}
for (const mode of ['throw', 'reject', 'error', 'extra', 'badCatalog', 'wrongSite', 'wrongPackage', 'preAbort', 'lateAbort']) test(`export begin ${mode} clears one-use password and never leaks/retries`, async () => {
  const h = harness(), s = api.createFinanceExportSession(PACKAGE, PASSWORD), c = new AbortController();
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
test('global per-session exclusion covers export and import operations, including source.catalog during pending request', async () => {
  const h = harness(), s = api.createFinanceExportSession(PACKAGE, PASSWORD), gate = deferred(); h.replies.push({ wait: gate.promise });
  const pending = s.begin(); await assert.rejects(s.begin(), /cannot be retried/); await assert.rejects(s.source.catalog(), /already in progress/);
  await nextTurn(); assert.equal(h.calls[0].args.p_admin_password, PASSWORD); gate.resolve({ data: { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() } }); await pending;
  const i = await imported(h), g = deferred(); h.replies.push({ wait: g.promise }); const planned = i.plan(); await nextTurn();
  for (const call of [() => i.apply(id(1), PLAN), () => i.verify(), () => i.target.bind(catalog()), () => i.target.stage('wallets', 0, line('wallets', 1))]) await assert.rejects(call(), /already in progress/);
  g.resolve({ data: plan() }); await planned;
});
test('API validates exact raw stage chunks and empty-table chunk zero before RPC', async () => {
  const h = harness(), s = await imported(h), before = h.calls.length;
  for (const [key, no, value] of [['wallets', 0, ''], ['wallets', -1, line('wallets', 1)], ['wallets', 500001, line('wallets', 1)], ['wallets', 0, line('wallets', 1).trimEnd()], ['bad', 0, '']]) await assert.rejects(s.target.stage(key, no, value));
  assert.equal(h.calls.length, before); const raw = line('wallet_transactions', 1); h.respond(ack(raw)); await s.target.stage('wallet_transactions', 0, raw);
  assert.equal(h.calls.at(-1).args.p_ndjson, raw);
  const e = api.createFinanceImportSession(TOKEN); h.respond(bound()); await e.target.bind(catalog(Object.fromEntries(TABLES.map(key => [key, '']))));
  h.respond(ack('')); await e.target.stage('wallets', 0, ''); await assert.rejects(e.target.stage('wallets', 1, ''));
});
test('line/page byte boundaries include LF and UTF8, original 64KiB rows split exact 256KiB pages', async () => {
  const key = 'wallet_transactions', f = fixture([0, 0, 0, 5, 0, 0]);
  f.texts[key] = Array.from({ length: 5 }, (_, i) => { const r = row(key, i + 1); r.remarks = '';
    r.remarks = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(r) + '\n')); return JSON.stringify(r) + '\n'; }).join('');
  f.cat = catalog(f.texts); await exportRun(f); await stageRun(f);
  assert.deepEqual(f.calls.pages.filter(p => p.key === key).map(p => p.after), [null, id(4)]);
  assert.deepEqual(f.calls.stage.filter(p => p.key === key).map(p => Buffer.byteLength(p.ndjson)), [262144, 65536]);
  const exact = f.texts[key].match(/[^\n]*\n/g)[0]; api.validateFinanceRow(exact, key); assert.throws(() => api.validateFinanceRow(exact.replace('"remarks":"', '"remarks":"x'), key));
  const ndjson = 'é'.repeat(131073); assert.throws(() => api.validateFinancePage({ table_key: key, count: 1, ndjson, next_after: null, sha256: sha(ndjson) }, key, null));
});
test('input buffer reuse and sink buffer detachment cannot corrupt digests or acknowledged byte counts', async () => {
  const f = fixture([1, 1, 1, 1, 1, 1]), write = f.sink.append; f.sink.append = async (path, bytes) => { await write(path, bytes); structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); };
  assert.equal((await exportRun(f)).bytes, f.cat.tables.reduce((sum, t) => sum + t.bytes, 0));
  f.files.open = path => ({ async *[Symbol.asyncIterator]() {
    const key = TABLES.find(k => path === `data/finance-${k}.ndjson`), bytes = Buffer.from(f.texts[key]), reused = Buffer.alloc(41);
    for (let i = 0; i < bytes.length; i += 41) { const size = Math.min(41, bytes.length - i); bytes.copy(reused, 0, i, i + size); yield reused.subarray(0, size); }
  } }); f.target.bind = async () => bound(); await stageRun(f);
});
test('real isolated temporary files export byte-for-byte, reopen twice as ReadableStreams, and delete all plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'employee-finance-client-')), f = fixture([2, 2, 203, 203, 203, 203]); let discarded = false;
  const filePath = path => { assert.ok(TABLES.some(key => path === `data/finance-${key}.ndjson`)); return join(directory, path.split('/')[1]); };
  const temporary = {
    async append(path, bytes) { assert.equal(discarded, false); const fd = await open(filePath(path), 'a', 0o600); try { await fd.writeFile(bytes); } finally { await fd.close(); } },
    open(path) { assert.equal(discarded, false); return new ReadableStream({ async start(controller) {
      const fd = await open(filePath(path), 'r'); try { for await (const bytes of fd.createReadStream({ highWaterMark: 97, autoClose: false })) controller.enqueue(bytes); controller.close(); }
      catch (error) { controller.error(error); } finally { await fd.close(); }
    } }); },
    async abort() { discarded = true; await rm(directory, { recursive: true, force: true }); },
  };
  try {
    const r = await api.exportFinanceData(f.source, temporary); for (const entry of r.entries) assert.equal(sha(await readFile(filePath(entry.path))), entry.sha256);
    f.target.bind = async c => { assert.deepEqual(c, f.cat); return bound(); }; const imported = await api.stageFinanceImport(r.catalog, temporary, f.target);
    assert.equal(imported.rows, 816); assert.equal(discarded, true); await assert.rejects(readFile(join(directory, 'finance-wallets.ndjson')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('authenticated manifest binds exact same site/package and ordered six-file catalog', () => {
  const c = catalog(), m = { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: JOB, sourceSiteId: SITE,
    createdAt: '2026-10-18T01:02:03Z', volumeIndex: 1, volumeCount: 1,
    entries: c.tables.map(t => ({ path: `data/finance-${t.key}.ndjson`, kind: 'ndjson', bytes: t.bytes, sha256: sha(text(t.key, 1)) })) };
  api.validateFinanceManifest(m, c);
  for (const change of [v => { v.exportId = OTHER; }, v => { v.sourceSiteId = OTHER; }, v => { v.volumeCount = 2; }, v => { v.entries.reverse(); }, v => { v.entries[0].bytes++; }, v => { v.entries[0].path = '../wallets.ndjson'; }]) {
    const bad = structuredClone(m); change(bad); assert.throws(() => api.validateFinanceManifest(bad, c));
  }
});
