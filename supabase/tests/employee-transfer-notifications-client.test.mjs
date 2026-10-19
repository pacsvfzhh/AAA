import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TRANSFER_SCOPE_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SITE = '55555555-5555-4555-8555-555555555555', PACKAGE = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666', SECRET = 'never-echo-notifications-raw-backend-error';
const TIME = '2024-02-29T12:34:56.123456+00:00', PRECISE = '12345678901234567890.12345678901234567890';
const TABLES = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const CONFLICTS = ['source_employee_missing', 'source_admin_unmapped', 'source_reference_missing', 'source_scope_mismatch',
  'source_unique_collision', 'reward_link_mismatch', 'unfinished_execution', 'unsupported_date_runs'];
const LEASES = ['delivery_claim_token', 'delivery_claim_channel', 'delivery_claim_until', 'delivery_completed_claim_token'];
const COMPOSITE = [TABLES[2], TABLES[3], TABLES[4], TABLES[6], TABLES[7]];
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const nrows = value => value ? value.split('\n').length - 1 : 0;
const rowHash = value => sha((value.match(/[^\n]*\n/g) ?? []).map(item => sha(item)).join(''));
const columns = key => TRANSFER_SCOPE_COVERAGE_INVENTORY.find(t => t.schema === 'public' && t.name === key).columns.filter(c => !LEASES.includes(c.name));
function row(key, n = 1) {
  const result = Object.fromEntries(columns(key).map(c => [c.name, ({ uuid: id(n), text: '原文é é 𠮷', integer: 1, smallint: 1,
    bigint: '9223372036854775807', numeric: 0, boolean: true, 'timestamp with time zone': TIME,
    jsonb: { trigger_type: 'total_orders', trigger_mode: 'reach_once', threshold_value: 0, minimum_daily_orders: null, minimum_daily_work_minutes: null } })[c.type]]));
  if ('status' in result) result.status = key === TABLES[5] ? 'succeeded' : 'active';
  if ('message_type' in result) result.message_type = key === TABLES[11] ? 'text' : 'realtime';
  if ('priority' in result) result.priority = 'normal';
  if ('delivery_mode' in result) result.delivery_mode = 'realtime_with_login_fallback';
  if ('delivery_channel' in result) result.delivery_channel = null;
  if ('notification_category' in result) result.notification_category = 'standard';
  if ('audit_origin' in result) result.audit_origin = 'unverified';
  if ('target_type' in result) result.target_type = 'all';
  if ('trigger_type' in result) result.trigger_type = 'total_orders';
  if ('trigger_mode' in result) result.trigger_mode = 'reach_once';
  if ('recipient_scope' in result) result.recipient_scope = 'selected';
  if ('period_key' in result) result.period_key = 'A:2024-02_29.01';
  if ('last_period_key' in result) result.last_period_key = 'A:2024-02_29.01';
  if ('error_message' in result) result.error_message = null;
  if ('last_error' in result) result.last_error = 'redacted migration error';
  if (COMPOSITE.includes(key)) {
    result.task_id = id(1);
    if (key === TABLES[2]) { delete result.task_id; result.id = result.user_id; }
    else if (key === TABLES[6]) { result.task_version = n; result.id = `${result.task_id}:${String(n).padStart(10, '0')}:${result.period_key}`; }
    else result.id = `${result.task_id}:${result.user_id}`;
  }
  return result;
}
const line = (key, n = 1) => JSON.stringify(row(key, n)).replace(/"(threshold_value|actual_value|last_metric|reward_amount)":0/g, `"$1":${PRECISE}`) + '\n';
const text = (key, n) => Array.from({ length: n }, (_, i) => line(key, i + 1)).join('');
const ack = value => ({ success: true, rows: nrows(value), bytes: Buffer.byteLength(value), sha256: sha(value), repeated: false });
const bound = () => ({ success: true, scope: 'site-notifications', repeated: false, full_site_complete: false });
const verified = () => ({ verified: true, scope: 'site-notifications', media_pending: true, full_site_complete: false });
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
function identity(employees = 1) {
  return { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE, processing_orders: 0, full_site_complete: false,
    tables: ['accounts', 'credentials', 'orders'].map((key, i) => ({ key, rows: i === 0 ? employees : 0, bytes: i === 0 ? employees * 500 : 0, row_hashes_sha256: sha('') })) };
}
function catalog(texts = Object.fromEntries(TABLES.map(key => [key, line(key)])), employees = 1) {
  return { version: 1, scope: 'site-notifications', site_id: SITE, package_id: PACKAGE, identity_catalog: identity(employees),
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE, identity_catalog: identity(employees),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    date_runs_supported: true, tables: TABLES.map(key => ({ key, rows: nrows(texts[key]), bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })), full_site_complete: false };
}
function plan(cat = catalog()) {
  return { scope: 'site-notifications', checked: true, can_restore: false, restore_pending: true, media_pending: true, automation_pending: true,
    counts: Object.fromEntries(cat.tables.map(t => [t.key, t.rows])), employees: cat.identity_catalog.tables[0].rows, rewards: 1,
    conflicts: [], plan_hash: 'a'.repeat(64), ...flags() };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
const redacted = error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false); assert.equal('cause' in error, false); return true; };
mock.method(globalThis, 'fetch', () => assert.fail('production/network access forbidden'));
after(() => mock.restoreAll());
const compiled = await build({ entryPoints: [`${root}src/lib/employeeTransfer/notificationsTransfer.ts`], bundle: true, write: false,
  platform: 'browser', format: 'esm', target: 'es2020', metafile: true });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function page(key, ndjson, next_after = null) { return { table_key: key, count: nrows(ndjson), ndjson, next_after, sha256: sha(ndjson) }; }
function fixture(n = 1) {
  const texts = Object.fromEntries(TABLES.map(key => [key, text(key, n)])), cat = catalog(texts);
  const calls = { pages: [], open: [], stages: [], bind: 0, plan: 0, verify: 0, cleanup: 0, eof: [] }, stored = new Map(), progress = [];
  const f = { texts, cat, calls, stored, progress };
  f.source = { async catalog() { return f.cat; }, async page(key, after) {
    calls.pages.push({ key, after });
    const all = f.texts[key].match(/[^\n]*\n/g) ?? [];
    let index = after === null ? 0 : all.findIndex(raw => JSON.parse(raw).id === after) + 1;
    const output = []; let bytes = 0;
    while (index < all.length && output.length < 200 && bytes + Buffer.byteLength(all[index]) <= 262144) { bytes += Buffer.byteLength(all[index]); output.push(all[index++]); }
    return page(key, output.join(''), index < all.length ? JSON.parse(output.at(-1)).id : null);
  }, async verify() { calls.verify++; return verified(); } };
  f.sink = { async append(path, bytes) { stored.set(path, Buffer.concat([stored.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); },
    async abort() { calls.cleanup++; stored.clear(); } };
  f.files = { open(path) {
    calls.open.push(path); const key = TABLES.find(key => path === api.notificationsEntryPath(key)); assert.ok(key);
    const bytes = Buffer.from(f.texts[key]);
    return { async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 97) yield bytes.subarray(i, i + 97); calls.eof.push(key); } };
  }, async abort() { calls.cleanup++; stored.clear(); } };
  f.target = { async bind(input) { assert.deepEqual(input, f.cat); assert.deepEqual(calls.eof, TABLES); calls.bind++; return bound(); },
    async stage(key, chunkNo, ndjson) { calls.stages.push({ key, chunkNo, ndjson }); return ack(ndjson); },
    async plan() { calls.plan++; return plan(f.cat); } };
  return f;
}
const exportRun = (f, options = {}) => api.exportNotificationsData(f.source, f.sink, { onProgress: p => f.progress.push(p), ...options });
const stageRun = (f, options = {}) => api.stageNotificationsImport(f.cat, f.files, f.target, { onProgress: p => f.progress.push(p), ...options });

test('fixed protocol, 13 keys/limits and lightweight real identity/finance dependencies', () => {
  assert.equal(api.NOTIFICATIONS_PROTOCOL, 'site-notifications-v1'); assert.deepEqual(api.NOTIFICATIONS_TABLE_KEYS, TABLES);
  assert.deepEqual(api.NOTIFICATIONS_CONFLICT_REASONS, CONFLICTS);
  assert.deepEqual(api.NOTIFICATIONS_TRANSFER_LIMITS, { maxRows: 500000, maxTableBytes: 268435456, maxTotalBytes: 1073741824,
    maxLineBytes: 65536, maxPageRows: 200, maxPageBytes: 262144, maxChunks: 500001, maxInputBytes: 1048576 });
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['notificationsTransfer', 'identityTransfer', 'financeTransfer', 'sha256']) assert.ok(inputs.some(path => path.endsWith(`/${name}.ts`)));
  assert.equal(inputs.some(path => /node_modules|transfer-scope|\/(?:container|crypto|manifest)\.ts$/.test(path)), false);
});
for (const key of TABLES) {
  test(`${key}: all inventory columns and exact original precision/UTF8/microseconds`, () => { assert.equal(api.validateNotificationsRow(line(key), key), row(key).id); });
  for (const c of columns(key)) {
    test(`${key}.${c.name}: required presence`, () => { const r = row(key); delete r[c.name]; assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), key)); });
    test(`${key}.${c.name}: physical nullability`, () => { const r = row(key); r[c.name] = null;
      if (c.nullable) assert.equal(api.validateNotificationsRow(JSON.stringify(r), key), r.id);
      else assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), key)); });
    test(`${key}.${c.name}: wrong type rejected`, () => { const r = row(key); r[c.name] = c.type === 'jsonb' ? [] : {};
      assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), key)); });
  }
  for (const [label, edit] of [['unknown', r => { r.secret = SECRET; }], ['id mismatch', r => { r.id = OTHER; }]]) {
    if (label === 'id mismatch' && !COMPOSITE.includes(key)) continue;
    test(`${key}: rejects ${label}`, () => { const r = row(key); edit(r); assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), key)); });
  }
  test(`${key}: duplicate and escaped-equivalent keys rejected`, () => {
    for (const name of ['id', '\\u0069d']) assert.throws(() => api.validateNotificationsRow(line(key).replace('{', `{"${name}":"${row(key).id}",`), key));
  });
}
for (const field of LEASES) test(`recipient lease ${field} rejected even when null`, () => {
  assert.throws(() => api.validateNotificationsRow(JSON.stringify({ ...row(TABLES[9]), [field]: null }), TABLES[9]));
});
test('all nullable business states retained, not coerced to false/empty', () => {
  for (const key of TABLES) { const r = row(key); for (const c of columns(key)) if (c.nullable) r[c.name] = null;
    assert.equal(api.validateNotificationsRow(JSON.stringify(r), key), r.id); }
});
for (const [key, field, allowed] of [[TABLES[5], 'stage', ['1', '9223372036854775807']], [TABLES[4], 'last_stage', ['0', '9223372036854775807']],
  [TABLES[9], 'delivery_sequence', ['1', '9223372036854775807']]]) {
  for (const value of allowed) test(`${field}: accepts exact signed-bigint ceiling ${value}`, () => { const r = row(key); r[field] = value; api.validateNotificationsRow(JSON.stringify(r), key); });
  for (const value of [1, '01', '-0', '+1', '1.0', '1e2', '9223372036854775808', '-9223372036854775809', '-1', '-9223372036854775808', '1\n', '1\r', '1\u2028', '1\u2029', '', ...(field === 'last_stage' ? [] : ['0'])]) {
    test(`${field}: rejects noncanonical/out-of-range/nonpositive ${JSON.stringify(value)}`, () => { const r = row(key); r[field] = value; assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), key)); });
  }
}
for (const key of [TABLES[5], TABLES[6], TABLES[4]]) for (const value of ['', '汉字', 'A/B', 'a b', 'a\n', 'a\r', 'a\u2028', 'a\u2029', 'a'.repeat(129)]) {
  test(`${key}: rejects unsafe period ${JSON.stringify(value)}`, () => { const r = row(key); r[key === TABLES[4] ? 'last_period_key' : 'period_key'] = value;
    assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), key)); });
}
test('date run composite cursors pad version to ten decimal digits and use C text sorting', () => {
  for (const n of [1, 9, 10, 2147483647]) assert.equal(api.notificationsCursor(TABLES[6], row(TABLES[6], n).id), row(TABLES[6], n).id);
  const raw = [1, 2, 10].map(n => line(TABLES[6], n)).join(''); api.validateNotificationsPage(page(TABLES[6], raw), TABLES[6], null);
  for (const bad of [`${id(1)}:1:A`, `${id(1)}:0000000000:A`, `${id(1)}:2147483648:A`, `${id(1)}:0000000001:汉`, `${id(1)}:0000000001:A\n`]) assert.throws(() => api.notificationsCursor(TABLES[6], bad));
  const r = row(TABLES[6]); r.id = `${r.task_id}:0000000002:${r.period_key}`; assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), TABLES[6]));
  for (const key of COMPOSITE) { api.notificationsCursor(key, row(key).id); assert.throws(() => api.notificationsCursor(key, row(key).id + '/x')); }
});
for (const [label, change] of [
  ['JSON null', r => { r.trigger_snapshot = null; }], ['array', r => { r.trigger_snapshot = []; }], ['string', r => { r.trigger_snapshot = '{}'; }],
  ['unknown', r => { r.trigger_snapshot.secret = SECRET; }], ['missing first5', r => { delete r.trigger_snapshot.minimum_daily_orders; }],
  ['trigger enum', r => { r.trigger_snapshot.trigger_type = SECRET; }], ['mode enum', r => { r.trigger_snapshot.trigger_mode = SECRET; }],
  ['numeric type', r => { r.trigger_snapshot.threshold_value = PRECISE; }], ['integer type', r => { r.trigger_snapshot.minimum_daily_orders = '1'; }],
  ['annual type', r => { r.trigger_snapshot.annual_month = true; }],
]) test(`trigger snapshot rejects ${label}`, () => { const r = row(TABLES[5]); change(r); assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), TABLES[5])); });
test('trigger object optional annual fields, nullable settings, nested escaped duplicate and redacted errors', () => {
  const r = row(TABLES[5]); Object.assign(r.trigger_snapshot, { annual_month: 2, annual_day: 29 }); r.error_message = 'redacted migration error';
  api.validateNotificationsRow(JSON.stringify(r), TABLES[5]);
  assert.throws(() => api.validateNotificationsRow(JSON.stringify(r).replace('"trigger_mode":', '"\\u0074rigger_type":"first_login","trigger_mode":'), TABLES[5]));
  for (const key of [TABLES[5], TABLES[7]]) { const bad = row(key); bad[key === TABLES[5] ? 'error_message' : 'last_error'] = SECRET;
    assert.throws(() => api.validateNotificationsRow(JSON.stringify(bad), key), redacted); }
});
for (const [key, field] of [[TABLES[0], 'status'], [TABLES[1], 'status'], [TABLES[1], 'trigger_type'], [TABLES[1], 'trigger_mode'],
  [TABLES[1], 'recipient_scope'], [TABLES[1], 'delivery_mode'], [TABLES[5], 'status'], [TABLES[8], 'message_type'], [TABLES[8], 'priority'],
  [TABLES[8], 'notification_category'], [TABLES[8], 'audit_origin'], [TABLES[9], 'delivery_channel'], [TABLES[10], 'delivery_mode'], [TABLES[11], 'message_type'], [TABLES[11], 'target_type']]) {
  test(`${key}.${field}: rejects unknown enum`, () => { const r = row(key); r[field] = SECRET; assert.throws(() => api.validateNotificationsRow(JSON.stringify(r), key), redacted); });
}
for (const [label, edit] of [
  ['scope', c => { c.scope = 'employee-activity'; }], ['version', c => { c.version = 2; }], ['full site', c => { c.full_site_complete = true; }],
  ['order', c => { c.tables.reverse(); }], ['missing table', c => { c.tables.pop(); }], ['extra field', c => { c.secret = SECRET; }],
  ['sparse array', c => { delete c.tables[0]; }], ['extra array property', c => { c.tables.secret = SECRET; }], ['table rows', c => { c.tables[0].rows = 500001; }],
  ['table bytes', c => { c.tables[0].bytes = 268435457; }], ['total bytes', c => { c.tables.forEach(t => { t.bytes = 268435456; }); }],
  ['fraction', c => { c.tables[0].rows = 0.5; }], ['empty mismatch', c => { c.tables[0].rows = 0; }], ['hash', c => { c.tables[0].row_hashes_sha256 += '\n'; }],
  ['UUID', c => { c.site_id += '\n'; }], ['date flag type', c => { c.date_runs_supported = 0; }], ['unsupported dates', c => { c.date_runs_supported = false; }],
  ['identity wrong package', c => { c.identity_catalog.package_id = OTHER; }], ['finance wrong site', c => { c.finance_catalog.site_id = OTHER; }],
  ['finance wrong package', c => { c.finance_catalog.package_id = OTHER; }], ['nested identity drift', c => { c.finance_catalog.identity_catalog.processing_orders = 1; }],
  ['nested finance extra', c => { c.finance_catalog.extra = true; }], ['nested identity hash', c => { c.finance_catalog.identity_catalog.tables[0].row_hashes_sha256 += '\n'; }],
  ['finance table hash', c => { c.finance_catalog.tables[0].row_hashes_sha256 += '\n'; }],
]) test(`catalog rejects ${label}`, () => { const c = catalog(); edit(c); assert.throws(() => api.validateNotificationsCatalog(c)); });
test('catalog supports missing date_runs only as exact empty digest; nested catalogs detached', () => {
  const f = fixture(0); f.cat.date_runs_supported = false; assert.deepEqual(api.validateNotificationsCatalog(f.cat), f.cat);
  f.cat.tables[6].row_hashes_sha256 = 'a'.repeat(64); assert.throws(() => api.validateNotificationsCatalog(f.cat));
  const c = catalog(), copy = api.validateNotificationsCatalog(c); copy.finance_catalog.identity_catalog.tables[0].rows = 2;
  copy.identity_catalog.tables[0].rows = 3; assert.equal(c.identity_catalog.tables[0].rows, 1); assert.equal(c.finance_catalog.identity_catalog.tables[0].rows, 1);
});
for (const [make, validate] of [[catalog, api.validateNotificationsCatalog], [plan, api.validateNotificationsPlan]]) for (const kind of ['getter', 'hidden', 'symbol', 'inherited']) {
  test(`${validate.name}: rejects ${kind} without reading getter`, () => { const value = make(), key = Object.keys(value)[0]; let reads = 0;
    if (kind === 'getter') Object.defineProperty(value, key, { enumerable: true, get() { reads++; throw Error(SECRET); } });
    if (kind === 'hidden') Object.defineProperty(value, key, { enumerable: false });
    if (kind === 'symbol') value[Symbol('x')] = true;
    if (kind === 'inherited') Object.setPrototypeOf(value, { x: true });
    assert.throws(() => validate(value)); assert.equal(reads, 0); });
}
for (const field of ['checked', 'can_restore', 'restore_pending', 'media_pending', 'automation_pending', ...Object.keys(flags())]) {
  test(`plan rejects unsafe ${field}`, () => { const p = plan(); p[field] = !p[field]; assert.throws(() => api.validateNotificationsPlan(p)); });
}
for (const reason of CONFLICTS) test(`read-only plan accepts ${reason} but never allows restore`, () => { const p = plan(); p.conflicts = [reason]; assert.deepEqual(api.validateNotificationsPlan(p), p); });
test('plan strict counts/rewards/hash/conflicts and conflict-free remains non-restorable', () => {
  assert.equal(api.validateNotificationsPlan(plan()).can_restore, false);
  for (const patch of [{ rewards: 500001 }, { rewards: -1 }, { rewards: 0.5 }, { employees: 500001 }, { conflicts: [SECRET] }, { plan_hash: 'a'.repeat(64) + '\n' }, { counts: {} }]) assert.throws(() => api.validateNotificationsPlan({ ...plan(), ...patch }));
  const p = plan(); p.rewards = 500000; api.validateNotificationsPlan(p);
});
test('page validates raw digest, C order, count, last cursor and whole LF termination', () => {
  const key = TABLES[3], raw = line(key, 1) + line(key, 2); assert.equal(api.validateNotificationsPage(page(key, raw, row(key, 2).id), key, null).ndjson, raw);
  for (const p of [{ ...page(key, raw), count: 3 }, { ...page(key, raw), sha256: 'a'.repeat(64) }, page(key, raw, row(key, 1).id),
    page(key, line(key, 2) + line(key, 1)), page(key, line(key, 1) + line(key, 1)), page(key, raw.trimEnd()), page(key, '\n')]) assert.throws(() => api.validateNotificationsPage(p, key, null));
  assert.throws(() => api.validateNotificationsPage(page(key, raw), key, row(key, 1).id));
  api.validateNotificationsPage(page(key, ''), key, null); assert.throws(() => api.validateNotificationsPage(page(key, '', row(key).id), key, null));
});
test('exact page200/row64KiB/page256KiB bounds with UTF8, no reserialization', () => {
  const key = TABLES[8]; api.validateNotificationsPage(page(key, text(key, 200)), key, null);
  assert.throws(() => api.validateNotificationsPage(page(key, text(key, 201)), key, null));
  const big = n => { const r = row(key, n); r.content = ''; r.content = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(r) + '\n')); return JSON.stringify(r) + '\n'; };
  const raw = [1, 2, 3, 4].map(big).join(''); assert.equal(Buffer.byteLength(raw), 262144); api.validateNotificationsPage(page(key, raw), key, null);
  assert.throws(() => api.validateNotificationsPage(page(key, raw + line(key, 5)), key, null));
  assert.throws(() => api.validateNotificationsRow(big(1).replace('xxx', 'xxxx'), key));
  assert.throws(() => api.validateNotificationsRow(line(key).replace('原文', '\\ud800'), key));
});
test('stage receipts require exact confirmed rows/bytes/digest/booleans', () => {
  const raw = line(TABLES[8]), expected = ack(raw); assert.deepEqual(api.validateNotificationsStage(expected, expected.rows, expected.bytes, expected.sha256), expected);
  for (const patch of [{ success: false }, { rows: 2 }, { bytes: 1 }, { sha256: 'b'.repeat(64) }, { repeated: null }, { x: 1 }]) assert.throws(() => api.validateNotificationsStage({ ...expected, ...patch }, expected.rows, expected.bytes, expected.sha256));
});
test('manifest accepts only ordered same-package 13 notification entries', () => {
  const c = catalog(), manifest = { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: OTHER, sourceSiteId: SITE,
    createdAt: TIME, volumeIndex: 1, volumeCount: 1, entries: c.tables.map(t => ({ path: api.notificationsEntryPath(t.key), kind: 'ndjson', bytes: t.bytes, sha256: 'a'.repeat(64) })) };
  api.validateNotificationsManifest(manifest, c);
  for (const edit of [m => { m.exportId = OTHER; }, m => { m.sourceSiteId = OTHER; }, m => { m.entries.reverse(); }, m => { m.entries.pop(); },
    m => { m.entries[0].path = 'data/accounts.ndjson'; }, m => { m.entries[0].bytes++; }, m => { m.entries[0].sha256 += '\n'; }, m => { m.volumeCount = 2; }]) {
    const m = structuredClone(manifest); edit(m); assert.throws(() => api.validateNotificationsManifest(m, c));
  }
});
test('all13 export pagination and two complete import passes preserve raw precision and final EOF', async () => {
  const f = fixture(205), result = await exportRun(f); assert.equal(result.rows, 2665); assert.equal(f.calls.verify, 1);
  for (const entry of result.entries) { const key = TABLES.find(k => api.notificationsEntryPath(k) === entry.path); assert.equal(f.stored.get(entry.path).toString(), f.texts[key]); assert.equal(entry.sha256, sha(f.texts[key])); }
  const staged = await stageRun(f); assert.equal(staged.plan.can_restore, false); assert.equal(staged.rows, 2665); assert.equal(f.calls.cleanup, 1);
  assert.deepEqual(f.calls.eof, [...TABLES, ...TABLES]); assert.equal(f.calls.open.length, 26);
  for (const key of TABLES) { const chunks = f.calls.stages.filter(c => c.key === key); assert.equal(chunks.map(c => c.ndjson).join(''), f.texts[key]);
    assert.deepEqual(chunks.map(c => c.chunkNo), chunks.map((_, i) => i)); for (const c of chunks) { assert.ok(nrows(c.ndjson) <= 200); assert.ok(Buffer.byteLength(c.ndjson) <= 262144); } }
});
test('empty13 and unsupported date table are read and staged explicitly, not fabricated', async () => {
  const f = fixture(0); f.cat.date_runs_supported = false; const exported = await exportRun(f); assert.equal(exported.entries.length, 13);
  const result = await stageRun(f); assert.equal(result.rows, 0); assert.equal(f.calls.stages.length, 13);
  assert.ok(f.calls.stages.every(c => c.chunkNo === 0 && c.ndjson === '')); assert.equal(f.calls.cleanup, 1);
});
for (const [label, corrupt] of [
  ['bad digest', f => { f.cat.tables[12].row_hashes_sha256 = 'b'.repeat(64); }], ['truncated EOF', f => { f.texts[TABLES[12]] = f.texts[TABLES[12]].trimEnd(); }],
  ['same count drift', f => { f.texts[TABLES[12]] = f.texts[TABLES[12]].replace(TIME, '2024-02-29T12:34:57.123456+00:00'); }],
]) test(`full first pass ${label} prevents all binds/stages and cleans plaintext`, async () => {
  const f = fixture(); corrupt(f); await assert.rejects(stageRun(f), redacted); assert.equal(f.calls.bind, 0); assert.equal(f.calls.stages.length, 0); assert.equal(f.calls.cleanup, 1);
});
test('second-pass tampering never requests plan and reports possible staging, not rollback', async () => {
  const f = fixture(), original = f.target.bind; f.target.bind = async c => { const receipt = await original(c); f.texts[TABLES[12]] = f.texts[TABLES[12]].replace(TIME, '2024-02-29T12:34:57.123456+00:00'); return receipt; };
  await assert.rejects(stageRun(f), e => e instanceof api.NotificationsImportStagingMayExistError && e.stagingMayExist && !e.cancelled);
  assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
});
for (const mode of ['bind', 'stage', 'plan', 'bad receipt', 'bad plan counts']) test(`unconfirmed ${mode}: no automatic retry/close/rollback; cleanup confirmed`, async () => {
  const f = fixture(); let attempts = 0;
  if (['bind', 'stage', 'plan'].includes(mode)) f.target[mode] = async () => { attempts++; throw Error(SECRET); };
  if (mode === 'bad receipt') f.target.stage = async () => { attempts++; return { ...ack(''), rows: 999 }; };
  if (mode === 'bad plan counts') f.target.plan = async () => { attempts++; const p = plan(f.cat); p.counts.messages++; return p; };
  await assert.rejects(stageRun(f), e => redacted(e) && e.stagingMayExist === true); assert.equal(attempts, 1); assert.equal(f.calls.cleanup, 1);
});
test('sink acknowledgment gates export progress and blocked writes cancel promptly', async () => {
  const f = fixture(), wait = deferred(), started = deferred(), controller = new AbortController();
  f.sink.append = async () => { started.resolve(); await wait.promise; };
  const run = exportRun(f, { signal: controller.signal }); await started.promise; assert.equal(f.progress.length, 0);
  controller.abort(Error(SECRET)); await assert.rejects(soon(run), e => redacted(e) && e.name === 'AbortError'); assert.equal(f.calls.cleanup, 1); wait.resolve();
});
test('stage acknowledgement gates progress; stalled stage abort warns server staging may exist', async () => {
  const f = fixture(), wait = deferred(), started = deferred(), controller = new AbortController();
  f.target.stage = async () => { started.resolve(); return wait.promise; }; const run = stageRun(f, { signal: controller.signal });
  await started.promise; assert.equal(f.progress.some(p => p.phase === 'stage'), false); controller.abort(Error(SECRET));
  await assert.rejects(soon(run), e => redacted(e) && e.stagingMayExist && e.cancelled); assert.equal(f.calls.cleanup, 1); wait.resolve(ack(line(TABLES[0])));
});
test('blocked first read cancellation invalidates iterator without waiting and never binds', async () => {
  const f = fixture(), wait = deferred(), started = deferred(), controller = new AbortController(); let returned = 0;
  f.files.open = () => ({ [Symbol.asyncIterator]() { return { next() { started.resolve(); return wait.promise; }, return() { returned++; return { done: true }; } }; } });
  const run = stageRun(f, { signal: controller.signal }); await started.promise; controller.abort(SECRET);
  await assert.rejects(soon(run), e => redacted(e) && e.name === 'AbortError'); assert.equal(returned, 1); assert.equal(f.calls.bind, 0); assert.equal(f.calls.cleanup, 1); wait.resolve({ done: true });
});
test('cancel during success cleanup still reports server staging may exist', async () => {
  const f = fixture(), started = deferred(), wait = deferred(), controller = new AbortController();
  f.files.abort = async () => { f.calls.cleanup++; started.resolve(); await wait.promise; };
  const run = stageRun(f, { signal: controller.signal }); await started.promise; controller.abort(SECRET); wait.resolve();
  await assert.rejects(run, e => e.stagingMayExist && e.cancelled); assert.equal(f.calls.plan, 1); assert.equal(f.calls.cleanup, 1);
});
test('cleanup failures preserve cleanupRequired and staging warning, redact underlying error', async () => {
  for (const stage of [false, true]) { const f = fixture(); if (!stage) f.cat.scope = 'bad'; f.files.abort = async () => { throw Error(SECRET); };
    await assert.rejects(stageRun(f), e => redacted(e) && e instanceof api.NotificationsTransferCleanupError && e.cleanupRequired && e.stagingMayExist === stage); }
  const f = fixture(); f.sink.append = async () => { throw Error(SECRET); }; f.sink.abort = async () => { throw Error(SECRET); };
  await assert.rejects(exportRun(f), e => redacted(e) && e.cleanupRequired);
});
test('invalid UTF8, oversized input fragments, read failures and stream reader cleanup', async () => {
  for (const bytes of [Buffer.from([255, 10]), new Uint8Array(1048577)]) { const f = fixture(); f.files.open = () => ({ async *[Symbol.asyncIterator]() { yield bytes; } });
    await assert.rejects(stageRun(f), redacted); assert.equal(f.calls.bind, 0); assert.equal(f.calls.cleanup, 1); }
  const f = fixture(); f.files.open = () => new ReadableStream({ pull() { throw Error(SECRET); } }); await assert.rejects(stageRun(f), redacted); assert.equal(f.calls.cleanup, 1);
});
test('export rejects unconfirmed verify/source/write errors with sanitized cleanup, no automatic close', async () => {
  for (const mode of ['source', 'write', 'verify']) { const f = fixture();
    if (mode === 'source') f.source.page = async () => { throw Error(SECRET); };
    if (mode === 'write') f.sink.append = async () => { throw Error(SECRET); };
    if (mode === 'verify') f.source.verify = async () => ({ ...verified(), media_pending: false });
    await assert.rejects(exportRun(f), redacted); assert.equal(f.calls.cleanup, 1); assert.equal(f.stored.size, 0); }
  await nextTurn();
});
test('paused sink and stage resume only after acknowledgment without duplicates or early progress', async () => {
  for (const mode of ['sink', 'stage']) {
    const f = fixture(), paused = deferred(), wait = deferred(); let first = true;
    if (mode === 'sink') { const append = f.sink.append; f.sink.append = async (...args) => { if (first) { first = false; paused.resolve(); await wait.promise; } await append(...args); }; }
    else { const stage = f.target.stage; f.target.stage = async (...args) => { if (first) { first = false; paused.resolve(); await wait.promise; } return stage(...args); }; }
    const run = mode === 'sink' ? exportRun(f) : stageRun(f); await paused.promise;
    const before = f.progress.length; await nextTurn(); assert.equal(f.progress.length, before); wait.resolve();
    const result = await run; assert.equal(result.rows, 13); assert.equal(f.calls.cleanup, mode === 'stage' ? 1 : 0);
    if (mode === 'stage') assert.equal(f.calls.stages.length, 13); else assert.equal(f.stored.size, 13);
  }
});
test('duplicate or descending composite cursors across export pages fail before a second sink write', async () => {
  const f = fixture(), key = TABLES[3]; let requests = 0, writes = 0;
  f.source.page = async current => { if (current !== key) return page(current, f.texts[current]); requests++; return page(key, line(key), row(key).id); };
  const append = f.sink.append; f.sink.append = async (...args) => { if (args[0] === api.notificationsEntryPath(key)) writes++; return append(...args); };
  await assert.rejects(exportRun(f), redacted); assert.equal(requests, 2); assert.equal(writes, 1); assert.equal(f.calls.cleanup, 1);
});
test('catalog accepts exact total1GiB and rejects one byte beyond, without allocating table data', () => {
  const c = catalog(); c.tables.forEach((t, index) => { t.rows = index < 4 ? 500000 : 0; t.bytes = index < 4 ? 268435456 : 0; if (index >= 4) t.row_hashes_sha256 = sha(''); });
  api.validateNotificationsCatalog(c); c.tables[4].rows = 1; c.tables[4].bytes = 1; c.tables[4].row_hashes_sha256 = 'a'.repeat(64);
  assert.throws(() => api.validateNotificationsCatalog(c));
});
