import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = `${root}src/lib/employeeTransfer/notificationsConfigurationApi.ts`;
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), JOB = id(2), PACKAGE = id(3), SOURCE = id(4), TARGET = id(5), BACKUP = id(6), OTHER = id(7);
const SECRET = 'never-echo-configuration-password-token-backend-details';
const PLAN_HASH = 'a'.repeat(64), TARGET_HASH = 'b'.repeat(64);
const sha = value => createHash('sha256').update(value).digest('hex');
const TABLES = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const CONFIGURATION = [TABLES[0], TABLES[1], TABLES[10]];
const CONFLICTS = ['source_employee_missing', 'source_admin_unmapped', 'source_reference_missing', 'source_scope_mismatch',
  'source_unique_collision', 'reward_link_mismatch', 'unfinished_execution', 'unsupported_date_runs', 'source_plan_unmapped',
  'ambiguous_notification_configuration', 'source_configuration_collision', 'notification_configuration_id_collision',
  'notification_many_to_one', 'target_member_outside_plan', 'target_notification_history', 'target_notification_uuid_collision', 'target_execution_unique_collision'];
const RPC = {
  plan: 'get_employee_import_notification_configuration_plan', prepare: 'employee_import_notification_backup_prepare',
  page: 'get_employee_import_notification_backup_page', verify: 'employee_import_notification_backup_verify',
  append: 'employee_import_notification_backup_append', seal: 'employee_import_notification_backup_seal',
  saved: 'get_employee_notification_saved_backup_chunk',
};
const AUTH_ARGS = { p_admin_session_token: SESSION, p_job_token: JOB };
const BACKUP_ARGS = { ...AUTH_ARGS, p_backup_id: BACKUP };
const HEX = Buffer.from('EDXSTRM1' + 'x'.repeat(56)).toString('hex');
const CIPHER_HASH = sha(Buffer.from(HEX, 'hex'));
const RAW = JSON.stringify({ id: id(50), sender_id: SESSION, sender_username: '原文𠮷', title: '通知', content: 'é é 𠮷',
  message_type: 'realtime', priority: 'normal', expires_at: null, created_at: '2024-02-29T12:34:56.123456+00:00',
  notification_category: 'standard', reward_amount: 0, reward_currency: null, automation_execution_id: null,
  delivery_mode: 'realtime_only', audit_origin: 'unverified' })
  .replace('"reward_amount":0', '"reward_amount":12345678901234567890.12345678901234567890') + '\n';
function catalog() {
  const identity = { version: 1, scope: 'employee-identity', site_id: SOURCE, package_id: PACKAGE, processing_orders: 0,
    tables: ['accounts', 'credentials', 'orders'].map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false };
  return { version: 1, scope: 'site-notifications', site_id: SOURCE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SOURCE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    date_runs_supported: false, tables: TABLES.map(key => ({ key, rows: CONFIGURATION.includes(key) ? 2 : key === 'messages' ? 1 : 0,
      bytes: CONFIGURATION.includes(key) ? 200 : key === 'messages' ? Buffer.byteLength(RAW) : 0,
      row_hashes_sha256: sha(CONFIGURATION.includes(key) ? `source-fixture:${key}` : key === 'messages' ? sha(RAW) : '') })), full_site_complete: false };
}
function plan(cat = catalog()) {
  return { scope: 'notification-configuration', records: CONFIGURATION.flatMap((table_key, index) => [
    { table_key, source_id: id(10 + index * 10), target_id: id(10 + index * 10), action: 'create' },
    { table_key, source_id: id(11 + index * 10), target_id: id(101 + index), action: 'replace' },
  ]), retire_tasks: [id(200)], members_removed: 1, conflicts: [], counts: Object.fromEntries(cat.tables.map(t => [t.key, t.rows])),
  checked: true, backup_required: true, can_prepare_backup: true, can_apply_configuration: false, media_pending: true,
  automation_pending: true, maintenance: true, replacement_ready: false, full_site_complete: false, target_hash: TARGET_HASH, plan_hash: PLAN_HASH };
}
function descriptor() {
  return { backup_id: BACKUP, plan_hash: PLAN_HASH, target_hash: TARGET_HASH,
    catalog: { version: 1, scope: 'notification-backup', site_id: TARGET, package_id: PACKAGE, date_runs_supported: false,
      tables: TABLES.map(key => ({ key, rows: key === 'messages' ? 1 : 0, bytes: key === 'messages' ? Buffer.byteLength(RAW) : 0,
        row_hashes_sha256: sha(key === 'messages' ? sha(RAW) : '') })), media_included: false, full_site_complete: false } };
}
const verification = () => ({ verified: true, backup_id: BACKUP, plan_hash: PLAN_HASH, target_hash: TARGET_HASH, media_included: false, full_site_complete: false });
const page = (key = 'messages', raw = RAW) => ({ table_key: key, count: raw ? raw.split('\n').length - 1 : 0, ndjson: raw, next_after: null, sha256: sha(raw) });
const appended = (hex = HEX) => ({ success: true, bytes: hex.length / 2, sha256: sha(Buffer.from(hex, 'hex')), repeated: false });
const sealed = (hash = CIPHER_HASH, bytes = 64) => ({ success: true, backup_id: BACKUP, sha256: hash, bytes, repeated: false, media_pending: true, full_site_complete: false });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('local cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
const redacted = error => {
  assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false); assert.equal('cause' in error, false); return true;
};
const uncertain = error => {
  redacted(error); assert.match(error.message, /outcome is unknown or unconfirmed/); assert.match(error.message, /backup data or a seal may exist/);
  assert.match(error.message, /Reconcile before retrying/); assert.match(error.message, /No automatic retry, rollback, apply, cancel or close/); return true;
};
mock.method(globalThis, 'fetch', () => assert.fail('production/network access forbidden'));
after(() => mock.restoreAll());

// Real validators and real lazy backup module; only the authentication and RPC transport are replaced.
// Instrumenting module evaluation distinguishes runtime lazy loading from esbuild's build-time traversal.
let moduleSequence = 0;
async function compile() {
  const output = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/notificationsConfigurationApi.ts';
    export {setHarness,backupLoads} from 'configuration-test:state';`, resolveDir: root, loader: 'js' },
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', plugins: [{ name: 'isolated-configuration', setup(builder) {
      builder.onResolve({ filter: /^(?:configuration-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
        if (args.path.startsWith('..')) assert.equal(args.importer, entry);
        return { path: args.path, namespace: 'configuration-test' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'configuration-test' }, ({ path }) => {
        if (path === 'configuration-test:state') return { contents: 'let h,loads=0; export const setHarness=v=>{h=v;}; export const current=()=>h; export const backupLoads=()=>loads; export const loaded=()=>{loads++;};' };
        if (path === '../auth') return { contents: `import {current} from 'configuration-test:state'; export function getAdminFinancialSessionToken(){const h=current();h.reads++;return h.session;}` };
        return { contents: `import {current} from 'configuration-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
      });
      builder.onLoad({ filter: /[/\\]notificationsBackup\.ts$/ }, async ({ path }) => ({ contents:
        `import {loaded} from 'configuration-test:state'; loaded();\n${await readFile(path, 'utf8')}`, loader: 'ts', resolveDir: `${root}src/lib/employeeTransfer` }));
    } }] });
  // Distinct data URLs prevent Node's module cache from sharing lazy-load state between compilations.
  const code = `${output.outputFiles[0].text}\n// isolated-local-test-module-${moduleSequence++}`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const api = await compile();
function harness(module = api) {
  const h = { calls: [], replies: [], reads: 0, session: SESSION,
    respond(data) { h.replies.push({ data }); }, rpc(name, args) {
      assert.ok(Object.values(RPC).includes(name), `forbidden RPC ${name}`);
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      assert.ok(h.replies.length, `unexpected RPC ${name}`);
      const reply = h.replies.shift(); if (reply.throw) throw reply.throw;
      const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
        return Promise.resolve().then(() => { if (reply.reject) throw reply.reject; return reply.wait ?? { data: reply.data, error: reply.error ?? null }; }).then(resolve, reject);
      } }; return query;
    } };
  module.setHarness(h); return h;
}
async function planned(h, module = api) {
  const s = module.createNotificationConfigurationSession(JOB, catalog()); h.respond(plan()); await s.plan(); return s;
}
async function prepared(h) { const session = await planned(h); h.respond(descriptor()); const backup = await session.backup(PLAN_HASH); return { session, backup }; }
async function ready(h) { const context = await prepared(h); h.respond(verification()); await context.backup.source.verify(); return context; }
function actions(session, backup) {
  return { plan: signal => session.plan(signal), prepare: signal => session.backup(PLAN_HASH, signal),
    catalog: signal => backup.source.catalog(signal), page: signal => backup.source.page('messages', null, signal),
    verify: signal => backup.source.verify(signal), append: signal => backup.receiver.append(0, HEX, signal),
    seal: signal => backup.receiver.seal(CIPHER_HASH, 64, signal) };
}
const replyFor = key => ({ plan: plan, prepare: descriptor, page, verify: verification, append: appended, seal: sealed })[key]();
function accessor(value, field, hits) {
  Object.defineProperty(value, field, { enumerable: true, configurable: true, get() { hits.count++; throw Error(SECRET); } }); return value;
}
function hostileGet(value, hits) { return new Proxy(value, { get() { hits.count++; throw Error(SECRET); } }); }
function throwsDescriptor(value, hits) { return new Proxy(value, { getOwnPropertyDescriptor() { hits.count++; throw Error(SECRET); } }); }

// Keep these as ordinary, non-skipped regression assertions even when the current implementation fails.
test('factory captures financial session once; source catalog and returned plans cannot mutate the bound closure', async () => {
  const h = harness(), input = catalog(), s = api.createNotificationConfigurationSession(JOB, input);
  assert.deepEqual(Object.keys(s).sort(), ['backup', 'plan']); assert.equal(h.reads, 1); assert.equal(h.calls.length, 0);
  input.tables[0].rows = 99; input.identity_catalog.site_id = OTHER; input.finance_catalog.package_id = OTHER; h.session = OTHER;
  const server = plan(); h.respond(server); const result = await s.plan(); assert.deepEqual(result, plan());
  result.plan_hash = TARGET_HASH; result.target_hash = PLAN_HASH; result.records[0].target_id = OTHER; result.conflicts.push('source_plan_unmapped'); result.can_prepare_backup = false;
  server.plan_hash = TARGET_HASH; server.counts.messages = 99;
  h.respond(descriptor()); await s.backup(PLAN_HASH);
  assert.deepEqual(h.calls.map(c => c.args), [AUTH_ARGS, { ...AUTH_ARGS, p_plan_hash: PLAN_HASH }]); assert.equal(h.reads, 1);
});
test('golden plan/prepare/catalog/page/verify/append/seal use exact SQL25 arguments and signals, no apply/close', async () => {
  const h = harness(), signal = new AbortController().signal, s = api.createNotificationConfigurationSession(JOB, catalog());
  h.respond(plan()); assert.deepEqual(await s.plan(signal), plan());
  h.respond(descriptor()); const b = await s.backup(PLAN_HASH, signal);
  assert.deepEqual(Object.keys(b).sort(), ['descriptor', 'receiver', 'source']);
  assert.deepEqual(Object.keys(b.source).sort(), ['catalog', 'page', 'verify']); assert.deepEqual(Object.keys(b.receiver).sort(), ['append', 'seal']);
  assert.deepEqual(b.descriptor, descriptor()); assert.deepEqual(await b.source.catalog(signal), descriptor().catalog);
  assert.notDeepEqual(b.descriptor.catalog, catalog()); assert.equal(b.descriptor.catalog.scope, 'notification-backup');
  h.respond(page()); assert.deepEqual(await b.source.page('messages', null, signal), page());
  h.respond(verification()); assert.deepEqual(await b.source.verify(signal), verification());
  h.respond({ ...appended(), repeated: true }); assert.deepEqual(await b.receiver.append(0, HEX, signal), { ...appended(), repeated: true });
  h.respond({ ...sealed(), repeated: true }); assert.deepEqual(await b.receiver.seal(CIPHER_HASH, 64, signal), { ...sealed(), repeated: true });
  assert.deepEqual(h.calls.map(c => [c.name, c.args]), [[RPC.plan, AUTH_ARGS], [RPC.prepare, { ...AUTH_ARGS, p_plan_hash: PLAN_HASH }],
    [RPC.page, { ...BACKUP_ARGS, p_table_key: 'messages', p_after: null, p_limit: 200 }], [RPC.verify, BACKUP_ARGS],
    [RPC.append, { ...BACKUP_ARGS, p_chunk_no: 0, p_hex: HEX }], [RPC.seal, { ...BACKUP_ARGS, p_sha256: CIPHER_HASH, p_bytes: 64 }]]);
  for (const call of h.calls) assert.deepEqual(call.signals, [signal]); assert.equal(h.replies.length, 0);
});
test('public descriptor, server payload and catalog copies cannot rewrite the frozen backup binding', async () => {
  const h = harness(), s = await planned(h), server = descriptor(); h.respond(server); const b = await s.backup(PLAN_HASH);
  b.descriptor.backup_id = OTHER; b.descriptor.plan_hash = TARGET_HASH; b.descriptor.target_hash = PLAN_HASH;
  b.descriptor.catalog.site_id = SOURCE; b.descriptor.catalog.package_id = OTHER; b.descriptor.catalog.tables[0].rows = 99;
  server.backup_id = OTHER; server.catalog.tables[8].rows = 0;
  const c = await b.source.catalog(); assert.deepEqual(c, descriptor().catalog); c.tables[8].rows = 99; c.site_id = SOURCE;
  assert.deepEqual(await b.source.catalog(), descriptor().catalog);
  h.respond(verification()); assert.deepEqual(await b.source.verify(), verification()); h.respond(appended()); await b.receiver.append(0, HEX);
  h.respond(sealed()); await b.receiver.seal(CIPHER_HASH, 64);
  for (const call of h.calls.slice(2)) assert.equal(call.args.p_backup_id, BACKUP);
});
test('backup validator module is evaluated only after a matching conflict-free plan requests preparation', async () => {
  const isolated = await compile(), h = harness(isolated), s = isolated.createNotificationConfigurationSession(JOB, catalog());
  assert.equal(isolated.backupLoads(), 0); await assert.rejects(s.backup(PLAN_HASH)); assert.equal(isolated.backupLoads(), 0);
  h.respond({ ...plan(), conflicts: ['source_plan_unmapped'], can_prepare_backup: false }); await s.plan();
  await assert.rejects(s.backup(PLAN_HASH)); assert.equal(isolated.backupLoads(), 0);
  h.respond(plan()); await s.plan(); await assert.rejects(s.backup(TARGET_HASH)); assert.equal(isolated.backupLoads(), 0);
  const controller = new AbortController(); controller.abort(SECRET); await assert.rejects(s.backup(PLAN_HASH, controller.signal)); assert.equal(isolated.backupLoads(), 0);
  h.respond(descriptor()); await s.backup(PLAN_HASH); assert.equal(isolated.backupLoads(), 1);
  h.respond(descriptor()); await s.backup(PLAN_HASH); assert.equal(isolated.backupLoads(), 1);
});
for (const field of ['session', 'job']) for (const [label, value] of [['null', null], ['empty', ''], ['secret', SECRET], ['LF', JOB + '\n'],
  ['uppercase', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'], ['object', { toString() { throw Error(SECRET); } }]]) {
  test(`factory rejects ${field} ${label} before RPC`, () => {
    const h = harness(); if (field === 'session') h.session = value;
    assert.throws(() => api.createNotificationConfigurationSession(field === 'job' ? value : JOB, catalog()), redacted); assert.equal(h.calls.length, 0);
  });
}
const catalogPatches = [
  ['wrong scope', c => { c.scope = 'notification-backup'; }], ['identity package', c => { c.identity_catalog.package_id = OTHER; }],
  ['finance package', c => { c.finance_catalog.package_id = OTHER; }], ['finance site', c => { c.finance_catalog.site_id = TARGET; }],
  ['nested identity mismatch', c => { c.finance_catalog.identity_catalog.tables[0].row_hashes_sha256 = PLAN_HASH; }],
  ['source package LF', c => { c.package_id += '\n'; }], ['extra field', c => { c.password = SECRET; }],
  ['missing table', c => { c.tables.pop(); }], ['table order', c => { c.tables.reverse(); }],
];
for (const [label, patch] of catalogPatches) test(`factory rejects unbound source catalog: ${label}`, () => {
  const h = harness(), c = catalog(); patch(c); assert.throws(() => api.createNotificationConfigurationSession(JOB, c), redacted); assert.equal(h.calls.length, 0);
});
for (const key of TABLES) test(`plan checks exact source count for ${key}`, async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()), result = plan(); result.counts[key]++;
  h.respond(result); await assert.rejects(s.plan(), uncertain); await assert.rejects(s.backup(PLAN_HASH)); assert.equal(h.calls.length, 1);
});
for (const [field, value] of [['scope', 'site-notifications'], ['checked', false], ['backup_required', false], ['can_prepare_backup', false],
  ['can_apply_configuration', true], ['media_pending', false], ['automation_pending', false], ['maintenance', false],
  ['replacement_ready', true], ['full_site_complete', true], ['target_hash', TARGET_HASH + '\n'], ['plan_hash', PLAN_HASH + '\n'],
  ['target_hash', TARGET_HASH.toUpperCase()], ['plan_hash', SECRET]]) test(`plan rejects unsafe ${field}=${String(value)}`, async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()); h.respond({ ...plan(), [field]: value });
  await assert.rejects(s.plan(), uncertain); await assert.rejects(s.backup(PLAN_HASH)); assert.equal(h.calls.length, 1);
});
const planPatches = [
  ['missing mapping record', p => { p.records.pop(); }], ['excess mapping record', p => { p.records.push({ ...p.records[0] }); }],
  ['duplicate source id in table', p => { p.records[1].source_id = p.records[0].source_id; }],
  ['per-table counts despite same total', p => { p.records[2].table_key = CONFIGURATION[0]; }],
  ['nonconfiguration table', p => { p.records[0].table_key = 'messages'; }], ['unknown action', p => { p.records[0].action = 'apply'; }],
  ['create remaps id', p => { p.records[0].target_id = OTHER; }], ['source id LF', p => { p.records[0].source_id += '\n'; }],
  ['target id malformed', p => { p.records[0].target_id = SECRET; }], ['unreported mapping conflict', p => { p.records[0].action = 'conflict'; }],
  ['unknown conflict', p => { p.conflicts = [SECRET]; p.can_prepare_backup = false; }],
  ['duplicate conflict', p => { p.conflicts = ['source_plan_unmapped', 'source_plan_unmapped']; p.can_prepare_backup = false; }],
  ['conflict falsely prepareable', p => { p.conflicts = ['source_plan_unmapped']; }],
  ['duplicate retired task', p => { p.retire_tasks.push(p.retire_tasks[0]); }],
  ['retired mapped task', p => { p.retire_tasks = [p.records[2].target_id]; }], ['bad retired uuid', p => { p.retire_tasks = [OTHER + '\n']; }],
  ['missing count key', p => { delete p.counts.messages; }], ['extra count key', p => { p.counts.orders = 0; }],
  ['extra metadata', p => { p.raw_error = SECRET; }], ['extra record metadata', p => { p.records[0].raw_error = SECRET; }],
];
for (const [label, patch] of planPatches) test(`plan rejects ${label}`, async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()), p = plan(); patch(p); h.respond(p);
  await assert.rejects(s.plan(), uncertain); await assert.rejects(s.backup(PLAN_HASH)); assert.equal(h.calls.length, 1);
});
for (const value of [-1, 0.5, 500001, NaN, Infinity, '1', null]) test(`plan rejects out-of-range members_removed ${String(value)}`, async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()); h.respond({ ...plan(), members_removed: value });
  await assert.rejects(s.plan(), uncertain); assert.equal(h.calls.length, 1);
});
for (const reason of CONFLICTS) test(`known conflict ${reason} is reported but blocks backup`, async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()), p = plan(); p.conflicts = [reason]; p.can_prepare_backup = false;
  p.records[0].action = 'conflict'; h.respond(p); const result = await s.plan(); assert.deepEqual(result, p);
  await assert.rejects(s.backup(PLAN_HASH), /conflict-free/); assert.equal(h.calls.length, 1);
});
for (const table of CONFIGURATION) test(`regression: ${table} many-to-one targets must not be reported conflict-free`, async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()), p = plan(), records = p.records.filter(r => r.table_key === table);
  records[0].action = 'replace'; records[0].target_id = records[1].target_id; h.respond(p);
  await assert.rejects(s.plan(), uncertain); await assert.rejects(s.backup(PLAN_HASH)); assert.equal(h.calls.length, 1);
});
test('source/target UUIDs may coincide across different configuration tables without false duplicate errors', async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()), p = plan();
  for (const r of p.records.slice(2)) {
    const first = p.records[r.action === 'create' ? 0 : 1]; r.source_id = first.source_id; r.target_id = first.target_id;
  }
  h.respond(p); assert.deepEqual(await s.plan(), p); assert.equal(h.calls.length, 1);
});
test('many-to-one conflict explicitly reported by SQL is accepted only as blocked plan', async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()), p = plan();
  p.records[0].action = p.records[1].action = 'conflict'; p.records[0].target_id = p.records[1].target_id;
  p.conflicts = ['notification_many_to_one']; p.can_prepare_backup = false; h.respond(p); assert.deepEqual(await s.plan(), p);
  await assert.rejects(s.backup(PLAN_HASH)); assert.equal(h.calls.length, 1);
});
test('empty configuration has zero mapping records and remains pending; complete source catalog is still bound', async () => {
  const h = harness(), c = catalog(); for (const t of c.tables) if (CONFIGURATION.includes(t.key)) Object.assign(t, { rows: 0, bytes: 0, row_hashes_sha256: sha('') });
  const p = plan(c); p.records = []; p.retire_tasks = []; p.members_removed = 500000;
  const s = api.createNotificationConfigurationSession(JOB, c); h.respond(p); assert.deepEqual(await s.plan(), p);
  h.respond(descriptor()); await s.backup(PLAN_HASH); assert.equal(h.calls.length, 2);
});
test('backup requires prior successful plan and exact lowercase hash; failed replanning revokes old plan', async () => {
  const h = harness(), s = api.createNotificationConfigurationSession(JOB, catalog()); await assert.rejects(s.backup(PLAN_HASH)); assert.equal(h.calls.length, 0);
  h.respond(plan()); await s.plan(); for (const value of [TARGET_HASH, PLAN_HASH + '\n', PLAN_HASH.toUpperCase(), null, SECRET]) await assert.rejects(s.backup(value));
  assert.equal(h.calls.length, 1); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.plan(), uncertain);
  await assert.rejects(s.backup(PLAN_HASH)); assert.equal(h.calls.length, 2);
});
const descriptorPatches = [
  ['backup id', d => { d.backup_id = BACKUP + '\n'; }], ['plan hash', d => { d.plan_hash = TARGET_HASH; }],
  ['target hash', d => { d.target_hash = PLAN_HASH; }], ['wrong package', d => { d.catalog.package_id = OTHER; }],
  ['source site as target', d => { d.catalog.site_id = SOURCE; }], ['wrong scope', d => { d.catalog.scope = 'site-notifications'; }],
  ['source catalog', d => { d.catalog = catalog(); }], ['media included', d => { d.catalog.media_included = true; }],
  ['full site complete', d => { d.catalog.full_site_complete = true; }], ['date runs unsupported but nonempty', d => { Object.assign(d.catalog.tables[6], { rows: 1, bytes: 1, row_hashes_sha256: PLAN_HASH }); }],
  ['missing table', d => { d.catalog.tables.pop(); }], ['table order', d => { d.catalog.tables.reverse(); }],
  ['negative table rows', d => { d.catalog.tables[0].rows = -1; }], ['row bytes mismatch', d => { d.catalog.tables[0].rows = 1; }],
  ['empty hash mismatch', d => { d.catalog.tables[0].row_hashes_sha256 = PLAN_HASH; }],
  ['plaintext limit', d => { d.catalog.tables[8].bytes = 8 * 1024 * 1024 + 1; }], ['extra metadata', d => { d.raw_error = SECRET; }],
];
for (const [label, patch] of descriptorPatches) test(`prepare rejects descriptor ${label}`, async () => {
  const h = harness(), s = await planned(h), d = descriptor(); patch(d); h.respond(d);
  await assert.rejects(s.backup(PLAN_HASH), uncertain); assert.equal(h.calls.length, 2);
});

// Exercise descriptors, not just JSON-shaped malicious inputs. No accessor/toJSON/iterator may run.
const locations = {
  catalog: { seed: catalog, run: value => api.createNotificationConfigurationSession(JOB, value), object: c => c.identity_catalog, array: c => c.tables },
  plan: { seed: plan, run: value => api.validateNotificationConfigurationPlan(value, catalog()), object: p => p.records[0], array: p => p.records },
};
for (const [location, spec] of Object.entries(locations)) for (const shape of ['root getter', 'nested getter', 'array getter', 'array subclass', 'sparse array', 'array symbol',
  'class instance', 'nonenumerable', 'root symbol', 'throwing descriptors']) test(`${location} rejects hostile ${shape} without invoking getters`, () => {
  const h = harness(), hits = { count: 0 }; let value = spec.seed(); const nested = spec.object(value), array = spec.array(value);
  if (shape === 'root getter') accessor(value, Object.keys(value)[0], hits);
  if (shape === 'nested getter') accessor(nested, Object.keys(nested)[0], hits);
  if (shape === 'array getter') accessor(array, '0', hits);
  if (shape === 'array subclass') Object.setPrototypeOf(array, class extends Array {}.prototype);
  if (shape === 'sparse array') delete array[0];
  if (shape === 'array symbol') array[Symbol('secret')] = SECRET;
  if (shape === 'class instance') Object.setPrototypeOf(value, class {}.prototype);
  if (shape === 'nonenumerable') Object.defineProperty(value, Object.keys(value)[0], { enumerable: false });
  if (shape === 'root symbol') value[Symbol('secret')] = SECRET;
  if (shape === 'throwing descriptors') value = throwsDescriptor(value, hits);
  assert.throws(() => spec.run(value), redacted); assert.equal(h.calls.length, 0); assert.equal(hits.count, shape === 'throwing descriptors' ? 1 : 0);
});
for (const location of ['catalog', 'plan', 'descriptor']) test(`${location} accepts only snapshot descriptors, never proxy property gets`, async () => {
  const h = harness(), hits = { count: 0 };
  if (location === 'catalog') {
    const c = catalog(); c.tables = hostileGet(c.tables, hits); c.identity_catalog = hostileGet(c.identity_catalog, hits);
    api.createNotificationConfigurationSession(JOB, hostileGet(c, hits));
  } else if (location === 'plan') {
    const p = plan(); p.records[0] = hostileGet(p.records[0], hits); p.records = hostileGet(p.records, hits); p.counts = hostileGet(p.counts, hits);
    assert.deepEqual(api.validateNotificationConfigurationPlan(hostileGet(p, hits), catalog()), plan());
  } else {
    const s = await planned(h), d = descriptor(); d.catalog.tables[0] = hostileGet(d.catalog.tables[0], hits);
    d.catalog.tables = hostileGet(d.catalog.tables, hits); d.catalog = hostileGet(d.catalog, hits); h.respond(hostileGet(d, hits));
    assert.deepEqual((await s.backup(PLAN_HASH)).descriptor, descriptor());
  }
  assert.equal(hits.count, 0);
});
for (const location of ['plan', 'descriptor']) for (const shape of ['getter', 'nested getter', 'array getter', 'throwing descriptors', 'prototype', 'extra symbol']) test(`${location} RPC ${shape} is sanitized`, async () => {
  const h = harness(), s = location === 'plan' ? api.createNotificationConfigurationSession(JOB, catalog()) : await planned(h), hits = { count: 0 };
  let value = location === 'plan' ? plan() : descriptor();
  if (shape === 'getter') accessor(value, Object.keys(value)[0], hits);
  if (shape === 'nested getter') accessor(location === 'plan' ? value.records[0] : value.catalog, location === 'plan' ? 'action' : 'site_id', hits);
  if (shape === 'array getter') accessor(location === 'plan' ? value.records : value.catalog.tables, '0', hits);
  if (shape === 'throwing descriptors') value = throwsDescriptor(value, hits);
  if (shape === 'prototype') Object.setPrototypeOf(value, class {}.prototype);
  if (shape === 'extra symbol') value[Symbol('secret')] = SECRET;
  h.respond(value); await assert.rejects(location === 'plan' ? s.plan() : s.backup(PLAN_HASH), uncertain);
  assert.equal(hits.count, shape === 'throwing descriptors' ? 1 : 0); assert.equal(h.calls.length, location === 'plan' ? 1 : 2);
});
for (const location of ['catalog', 'plan', 'descriptor']) for (const value of [null, [], new Date(0), new Map(), () => {}]) test(`${location} rejects non-record ${Object.prototype.toString.call(value)}`, async () => {
  const h = harness();
  if (location === 'catalog') assert.throws(() => api.createNotificationConfigurationSession(JOB, value), redacted);
  else if (location === 'plan') assert.throws(() => api.validateNotificationConfigurationPlan(value, catalog()), redacted);
  else { const s = await planned(h); h.respond(value); await assert.rejects(s.backup(PLAN_HASH), uncertain); }
  assert.equal(h.calls.length, location === 'descriptor' ? 2 : 0);
});
test('plain null-prototype and frozen source/plan data are valid descriptor snapshots', async () => {
  const h = harness(), c = catalog(), p = plan(); Object.setPrototypeOf(c, null); Object.freeze(c); Object.setPrototypeOf(p, null);
  Object.freeze(p.records); Object.freeze(p); const s = api.createNotificationConfigurationSession(JOB, c); h.respond(p);
  assert.deepEqual(await s.plan(), plan()); assert.equal(h.calls.length, 1);
});

for (const operation of ['append', 'seal']) test(`${operation} is forbidden until source verification, not merely prepare/catalog/page`, async () => {
  const h = harness(), { session, backup } = await prepared(h); await backup.source.catalog(); h.respond(page()); await backup.source.page('messages', null);
  await assert.rejects(actions(session, backup)[operation](), /verification is required/); assert.equal(h.calls.length, 3);
});
for (const field of ['verified', 'backup_id', 'plan_hash', 'target_hash', 'media_included', 'full_site_complete']) test(`bad verify receipt ${field} revokes previous upload and seal permission`, async () => {
  const h = harness(), { backup } = await ready(h), receipt = verification(); receipt[field] = typeof receipt[field] === 'boolean' ? !receipt[field] : OTHER;
  h.respond(receipt); await assert.rejects(backup.source.verify(), uncertain);
  await assert.rejects(backup.receiver.append(0, HEX), /verification is required/); await assert.rejects(backup.receiver.seal(CIPHER_HASH, 64), /verification is required/);
  assert.equal(h.calls.length, 4);
});
for (const operation of ['append', 'seal']) test(`regression: pre-aborted reverify revokes earlier ${operation} permission`, async () => {
  const h = harness(), { session, backup } = await ready(h), controller = new AbortController(); controller.abort(Error(SECRET));
  await assert.rejects(backup.source.verify(controller.signal), error => redacted(error) && error.name === 'AbortError');
  const before = h.calls.length;
  // Queue a real success so the regression cannot pass just because the mock ran out of replies.
  h.respond(replyFor(operation)); await assert.rejects(actions(session, backup)[operation](), /verification is required/); assert.equal(h.calls.length, before);
});
test('in-flight cancelled verify clears true; late successful receipt cannot restore it', async () => {
  const h = harness(), { backup } = await ready(h), wait = deferred(), controller = new AbortController(); h.replies.push({ wait: wait.promise });
  const run = backup.source.verify(controller.signal); await Promise.resolve(); controller.abort(Error(SECRET));
  await assert.rejects(soon(run), error => uncertain(error) && error.name === 'AbortError'); wait.resolve({ data: verification(), error: null });
  await new Promise(resolve => setImmediate(resolve)); await assert.rejects(backup.receiver.append(0, HEX), /verification is required/);
  await assert.rejects(backup.receiver.seal(CIPHER_HASH, 64), /verification is required/); assert.equal(h.calls.length, 4);
});
for (const mode of ['success', 'error', 'malformed', 'cancel']) test(`reading a page invalidates verified on ${mode}; catalog alone does not`, async () => {
  const h = harness(), { backup } = await ready(h); await backup.source.catalog(); h.respond(appended()); await backup.receiver.append(0, HEX);
  const controller = new AbortController(); let wait;
  if (mode === 'success') h.respond(page());
  if (mode === 'error') h.replies.push({ error: { message: SECRET } });
  if (mode === 'malformed') h.respond({ ...page(), sha256: PLAN_HASH });
  if (mode === 'cancel') { wait = deferred(); h.replies.push({ wait: wait.promise }); }
  const run = backup.source.page('messages', null, controller.signal);
  if (mode === 'success') await run;
  else { if (mode === 'cancel') { await Promise.resolve(); controller.abort(Error(SECRET)); } await assert.rejects(soon(run), uncertain); }
  if (wait) wait.resolve({ data: page(), error: null });
  await assert.rejects(backup.receiver.append(0, HEX), /verification is required/); await assert.rejects(backup.receiver.seal(CIPHER_HASH, 64), /verification is required/);
  h.respond(verification()); await backup.source.verify(); h.respond(appended()); await backup.receiver.append(0, HEX); assert.equal(h.calls.length, 7);
});
for (const key of TABLES) test(`backup page supports ${key}, canonical composite cursors and exact limit200`, async () => {
  const h = harness(), { backup } = await prepared(h);
  const after = [TABLES[3], TABLES[4], TABLES[7]].includes(key) ? `${id(10)}:${id(11)}` : key === TABLES[6] ? `${id(10)}:0000000010:A:2024` : id(10);
  h.respond(page(key, '')); assert.deepEqual(await backup.source.page(key, after), page(key, ''));
  assert.deepEqual(h.calls.at(-1), { name: RPC.page, args: { ...BACKUP_ARGS, p_table_key: key, p_after: after, p_limit: 200 }, signals: [] });
});
for (const [label, key, after] of [['unknown table', 'orders', null], ['bad UUID', 'messages', SECRET], ['UUID LF', 'messages', OTHER + '\n'],
  ['short composite', TABLES[3], `${OTHER}:x`], ['short version', TABLES[6], `${OTHER}:10:A`], ['unknown type', {}, null]]) test(`page rejects ${label} before RPC`, async () => {
  const h = harness(), { backup } = await prepared(h); await assert.rejects(backup.source.page(key, after), redacted); assert.equal(h.calls.length, 2);
});
for (const [field, value] of [['table_key', 'orders'], ['count', 0], ['count', 201], ['sha256', PLAN_HASH], ['ndjson', RAW.trimEnd()],
  ['next_after', OTHER], ['extra', SECRET]]) test(`page rejects malformed ${field} without accepting data`, async () => {
  const h = harness(), { backup } = await ready(h); h.respond({ ...page(), [field]: value }); await assert.rejects(backup.source.page('messages', null), uncertain);
  await assert.rejects(backup.receiver.append(0, HEX)); assert.equal(h.calls.length, 4);
});
for (const [label, no, hex] of [['negative', -1, HEX], ['fractional', 0.5, HEX], ['chunk overflow', 1024, HEX], ['string chunk', '0', HEX],
  ['empty', 0, ''], ['odd', 0, 'abc'], ['uppercase', 0, 'AB'], ['newline', 0, 'ab\n'], ['nonhex', 0, 'zz'], ['nonstring', 0, {}],
  ['oversize', 0, 'ab'.repeat(131073)]]) test(`append rejects ${label} before RPC`, async () => {
  const h = harness(), { backup } = await ready(h); await assert.rejects(backup.receiver.append(no, hex), redacted); assert.equal(h.calls.length, 3);
});
test('append permits inclusive chunk/hex boundaries and verifies actual binary SHA256, not hex text', async () => {
  const h = harness(), { backup } = await ready(h), hex = 'ab'.repeat(131072); h.respond(appended(hex)); await backup.receiver.append(1023, hex);
  assert.deepEqual(h.calls.at(-1).args, { ...BACKUP_ARGS, p_chunk_no: 1023, p_hex: hex });
  h.respond(appended('00')); await backup.receiver.append(0, '00'); assert.equal(h.calls.length, 5);
});
for (const [field, value] of [['success', false], ['bytes', 63], ['sha256', sha(HEX)], ['sha256', CIPHER_HASH + '\n'], ['repeated', 'yes'], ['extra', SECRET]]) test(`append rejects incorrect ${field} receipt exactly once`, async () => {
  const h = harness(), { backup } = await ready(h); h.respond({ ...appended(), [field]: value }); await assert.rejects(backup.receiver.append(0, HEX), uncertain); assert.equal(h.calls.length, 4);
});
for (const [label, digest, bytes] of [['short hash', 'a', 64], ['hash LF', CIPHER_HASH + '\n', 64], ['uppercase hash', CIPHER_HASH.toUpperCase(), 64],
  ['below minimum', CIPHER_HASH, 63], ['negative', CIPHER_HASH, -1], ['fractional', CIPHER_HASH, 64.5], ['above maximum', CIPHER_HASH, 9 * 1024 * 1024 + 1],
  ['string bytes', CIPHER_HASH, '64'], ['NaN', CIPHER_HASH, NaN]]) test(`seal rejects ${label} before RPC`, async () => {
  const h = harness(), { backup } = await ready(h); await assert.rejects(backup.receiver.seal(digest, bytes), redacted); assert.equal(h.calls.length, 3);
});
test('seal inclusive 9MiB limit forwards bytes/hash unchanged and accepts repeated acknowledgement', async () => {
  const h = harness(), { backup } = await ready(h), bytes = 9 * 1024 * 1024; h.respond({ ...sealed(CIPHER_HASH, bytes), repeated: true });
  assert.equal((await backup.receiver.seal(CIPHER_HASH, bytes)).repeated, true); assert.deepEqual(h.calls.at(-1).args, { ...BACKUP_ARGS, p_sha256: CIPHER_HASH, p_bytes: bytes });
});
for (const [field, value] of [['success', false], ['backup_id', OTHER], ['sha256', PLAN_HASH], ['bytes', 65], ['repeated', null],
  ['media_pending', false], ['full_site_complete', true], ['extra', SECRET]]) test(`seal rejects incorrect ${field} receipt and never claims completion`, async () => {
  const h = harness(), { backup } = await ready(h); h.respond({ ...sealed(), [field]: value }); await assert.rejects(backup.receiver.seal(CIPHER_HASH, 64), uncertain); assert.equal(h.calls.length, 4);
});
for (const operation of ['page', 'verify', 'append', 'seal']) for (const shape of ['getter', 'proxy descriptor', 'class']) test(`${operation} hostile receipt ${shape} is redacted`, async () => {
  const h = harness(), { session, backup } = await ready(h), hits = { count: 0 }; let data = replyFor(operation);
  if (shape === 'getter') accessor(data, Object.keys(data)[0], hits);
  if (shape === 'proxy descriptor') data = throwsDescriptor(data, hits);
  if (shape === 'class') Object.setPrototypeOf(data, class {}.prototype);
  h.respond(data); await assert.rejects(actions(session, backup)[operation](), uncertain); assert.equal(h.calls.length, 4);
  assert.equal(hits.count, shape === 'proxy descriptor' ? 1 : 0);
});

for (const operation of ['plan', 'prepare', 'page', 'verify', 'append', 'seal']) for (const mode of ['error', 'reject', 'throw', 'malformed']) test(`${operation} ${mode} warns about unknown outcome, redacts details and never retries`, async () => {
  const h = harness(), { session, backup } = await ready(h), before = h.calls.length;
  h.replies.push(mode === 'error' ? { error: { message: SECRET, details: SECRET, hint: SECRET } } : mode === 'reject' ? { reject: Error(SECRET) }
    : mode === 'throw' ? { throw: Error(SECRET) } : { data: { raw_error: SECRET } });
  await assert.rejects(actions(session, backup)[operation](), uncertain); assert.equal(h.calls.length, before + 1);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, before + 1); assert.equal(h.replies.length, 0);
  if (operation === 'verify') { await assert.rejects(backup.receiver.append(0, HEX)); await assert.rejects(backup.receiver.seal(CIPHER_HASH, 64)); }
  if (operation === 'plan') await assert.rejects(session.backup(PLAN_HASH));
});
for (const operation of ['plan', 'prepare', 'catalog', 'page', 'verify', 'append', 'seal']) test(`${operation} pre-aborted signal sends nothing and does not leak cancellation reason`, async () => {
  const h = harness(), { session, backup } = await ready(h), controller = new AbortController(), before = h.calls.length; controller.abort(Error(SECRET));
  await assert.rejects(actions(session, backup)[operation](controller.signal), error => redacted(error) && error.name === 'AbortError'); assert.equal(h.calls.length, before);
});
for (const operation of ['plan', 'prepare', 'page', 'verify', 'append', 'seal']) test(`${operation} in-flight cancellation is prompt, signal forwarded, late success unconfirmed`, async () => {
  const h = harness(), { session, backup } = await ready(h), controller = new AbortController(), wait = deferred(), before = h.calls.length;
  const started = deferred(), rpc = h.rpc; h.rpc = (...args) => { const query = rpc(...args); started.resolve(); return query; };
  h.replies.push({ wait: wait.promise }); const run = actions(session, backup)[operation](controller.signal); await soon(started.promise);
  assert.deepEqual(h.calls.at(-1).signals, [controller.signal]); controller.abort(Error(SECRET));
  await assert.rejects(soon(run), error => uncertain(error) && error.name === 'AbortError'); wait.resolve({ data: replyFor(operation), error: null });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, before + 1);
  if (operation === 'verify' || operation === 'page') await assert.rejects(backup.receiver.append(0, HEX), /verification is required/);
  if (operation === 'plan') await assert.rejects(session.backup(PLAN_HASH));
  // Cancellation must release the lock; reading the detached catalog is always local.
  assert.deepEqual(await backup.source.catalog(), descriptor().catalog);
});
for (const operation of ['plan', 'prepare', 'catalog', 'page', 'verify', 'append', 'seal']) test(`${operation} holds the same session-wide lock against every other method`, async () => {
  const h = harness(), { session, backup } = await ready(h), runAction = actions(session, backup), wait = deferred(), before = h.calls.length;
  if (operation !== 'catalog') h.replies.push({ wait: wait.promise });
  const run = runAction[operation]();
  // All seven attempts start synchronously while the first operation owns the lock.
  const blocked = Object.entries(runAction).map(([name, action]) => assert.rejects(action(), /already in progress/, name));
  if (operation !== 'catalog') wait.resolve({ data: replyFor(operation), error: null });
  await Promise.all(blocked); await run; assert.equal(h.calls.length, before + (operation === 'catalog' ? 0 : 1));
  assert.deepEqual(await backup.source.catalog(), descriptor().catalog);
});
test('distinct backups share the session lock but not each other\'s verification permission', async () => {
  const h = harness(), { session, backup: first } = await ready(h); h.respond(descriptor()); const second = await session.backup(PLAN_HASH);
  await assert.rejects(second.receiver.append(0, HEX), /verification is required/); h.respond(appended()); await first.receiver.append(0, HEX);
  const wait = deferred(); h.replies.push({ wait: wait.promise }); const run = first.source.page('messages', null);
  await assert.rejects(second.source.catalog(), /already in progress/); await assert.rejects(second.source.verify(), /already in progress/);
  wait.resolve({ data: page(), error: null }); await run; await assert.rejects(first.receiver.append(0, HEX), /verification is required/);
  assert.equal(h.calls.length, 6);
});
test('SQL25 declares exactly seven signatures; saved-chunk retrieval is not an implicit session action', async () => {
  const sql = await readFile(`${root}supabase/migrations/20261102000025_prepare_notification_configuration.sql`, 'utf8');
  const declared = [...sql.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(([^)]*)\)/g)];
  const expected = {
    [RPC.plan]: 'p_admin_session_token uuid,p_job_token uuid',
    [RPC.prepare]: 'p_admin_session_token uuid,p_job_token uuid,p_plan_hash text',
    [RPC.page]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200',
    [RPC.verify]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid',
    [RPC.append]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_chunk_no integer,p_hex text',
    [RPC.seal]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_sha256 text,p_bytes integer',
    [RPC.saved]: 'p_admin_session_token uuid,p_backup_id uuid,p_chunk_no integer',
  };
  assert.equal(declared.length, 7); assert.deepEqual(Object.fromEntries(declared.map(([, name, args]) => [name, args])), expected);
  const h = harness(), { session, backup } = await ready(h); assert.deepEqual(Object.keys(session).sort(), ['backup', 'plan']);
  assert.equal('apply' in session || 'close' in session || 'cancel' in session || 'restore' in session, false);
  assert.equal('close' in backup.source || 'apply' in backup.receiver, false); assert.equal(h.calls.some(c => c.name === RPC.saved), false);
});
