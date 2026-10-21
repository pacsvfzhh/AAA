import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { build } from 'esbuild';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

// Synthetic RPC bridge ONLY: SQL46/real database coverage belongs to the separate DB tests.
// Ciphertext, AES authentication, ZIP parsing, hashes and all workspace/file IO below are real.
for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
  mock.method(module, name, () => assert.fail('Network and production services forbidden'));
}
after(() => { assert.equal(globalThis.fetch.mock.callCount(), 0); mock.restoreAll(); });
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/employeeSafetyBackup.ts';
  export * from './src/lib/employeeTransfer/container.ts';
  export {EMPLOYEE_BACKUP_PROJECTIONS,EMPLOYEE_BACKUP_TABLE_KEYS,validateEmployeeBackupRow} from './src/lib/employeeTransfer/employeeBackup.ts';
  export {CHAT_TABLE_KEYS} from './src/lib/employeeTransfer/chatTransfer.ts';
  export {NOTIFICATIONS_TABLE_KEYS} from './src/lib/employeeTransfer/notificationsTransfer.ts';
  export {setHarness} from 'employee-safety-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'offline-only', setup(b) {
    b.onResolve({ filter: /^(?:employee-safety-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'employee-safety-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"employee-safety-test:state";export const getAdminFinancialSessionToken=()=>{const h=current();h.tokenReads++;return h.session;};'
        : 'import{current}from"employee-safety-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }],
});
assert.ok(!Object.keys(compiled.metafile.inputs).some(path => /node_modules\/@supabase|src\/lib\/(?:supabase|auth)\.ts|archiveBundle\.ts|replacementBackup\.ts/.test(path)));
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const TABLES = [...api.EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS], CATALOG_PATH = api.EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH;
const BEGIN = 'employee_safety_backup_begin', CATALOG = 'get_employee_safety_backup_catalog', PAGE = 'get_employee_safety_backup_page';
const VERIFY = 'employee_safety_backup_verify', CLOSE = 'employee_safety_backup_close';
const id = n => `a9000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SITE = id(1), JOB = id(2), EMPLOYEE = id(3), TOKEN = id(4), SESSION = id(5), OTHER = id(6);
const TIME = '2024-02-29T23:34:56.123456+00:00', NAME = 'Case-Sensitive é é 員工';
const PASS = 'independent local safety records encrypted backup', SECRET = 'NEVER-ECHO-ADMIN-PASSWORD-OR-SERVER-ERROR';
const PRECISE = '12345678901234567890.12345678901234567890', TINY = '0.00000000000000000001';
const flags = { records_only: true, media_included: false, complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
const sha = raw => createHash('sha256').update(raw).digest('hex');
const lines = value => value.match(/[^\n]*\n/g) ?? [];
const rowHash = value => sha(lines(value).map(sha).join(''));
async function spec(file, domain) {
  const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  const match = sql.match(new RegExp(`CREATE FUNCTION private.employee_transfer_${domain}_spec\\(\\)[\\s\\S]*?SELECT '([\\s\\S]*?)'::jsonb;`));
  assert.ok(match); return JSON.parse(match[1]);
}
const projections = { ...api.EMPLOYEE_BACKUP_PROJECTIONS,
  ...await spec('20261102000028_export_stage_site_chat.sql', 'chat'),
  ...await spec('20261102000023_export_stage_site_notifications.sql', 'notifications'),
  ...await spec('20261102000009_export_dispatch_submission_data.sql', 'dispatch'),
  ...await spec('20261102000033_transfer_readonly_archives.sql', 'archives'),
  orders_history: { id: 'uuid!', user_id: 'uuid!', status: 'text!', commission_amount: 'numeric', created_at: 'timestamp with time zone', completed_at: 'timestamp with time zone' },
  administrators: { id: 'uuid!', username: 'text!', role: 'text!', parent_id: 'uuid', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' } };
function rowObject(key, index = 0) {
  const row = Object.fromEntries(Object.entries(projections[key]).map(([field, spec]) => {
    const type = spec.replace(/!$/, '');
    return [field, type === 'uuid' ? id(1000 + TABLES.indexOf(key) * 500 + index)
      : type === 'text' ? '原始文字𠮷 é é' : type.startsWith('numeric') ? '__precise__' : type.startsWith('bigint') ? '9007199254740993'
        : type === 'boolean' ? false : ['integer', 'smallint'].includes(type) ? 1 : type === 'timestamp with time zone' ? TIME
          : type === 'text[]' ? ['標籤', null] : type === 'uuid[]' ? [EMPLOYEE, null] : null];
  }));
  if (['accounts', 'credentials', 'wallets', 'wallet_balance_baselines', 'work_stop_markers'].includes(key)) row.id = EMPLOYEE;
  for (const field of ['user_id', 'employee_id', 'recipient_id']) if (Object.hasOwn(row, field) && key !== 'accounts') row[field] = EMPLOYEE;
  if (key === 'accounts') Object.assign(row, { username: NAME, password_hash: '$2a$hash-account', updated_at: null, remarks: '原始備註\n𠮷', is_pinned: true });
  if (key === 'credentials') row.password_hash = '$2a$hash-financial';
  if (['orders', 'orders_history'].includes(key)) row.status = index % 2 ? 'failure' : 'success';
  if (key === 'orders_history' && index === 1) Object.assign(row, { commission_amount: null, created_at: null, completed_at: null });
  if (['wallet_ledger_entries', 'wallet_reconciliation_audit'].includes(key)) row.id = ['2', '10', '9007199254740993', '9223372036854775807'][index];
  if (key === 'employee_login_history') Object.assign(row, { session_id: `history-${'a'.repeat(64)}`, device_info: index < 2 ? null : { precise: '__precise__', tiny: '__tiny__', null: null }, device_info_is_sql_null: index === 0 });
  if (key === 'work_sessions') Object.assign(row, { end_time: null, last_heartbeat_at: null, duration_minutes: null });
  if (key === 'simulated_customers') Object.assign(row, { source_type: 'aaa_service', badge_type: null, target_employee_ids: [null], target_employee_id: OTHER });
  if (key === 'cs_message_templates') Object.assign(row, { source_type: 'aaa_service', content_type: 'text' });
  if (key === 'customer_auto_messages') Object.assign(row, { message_type: 'quick_send', content_type: 'text' });
  if (key === 'customer_employee_conversations') Object.assign(row, { source_type: 'aaa_service', sender_type: 'employee', message_type: 'text', rating_data: index === 0 ? null : { precise: '__precise__', tiny: '__tiny__' }, rating_data_sql_null: index === 0 });
  if (key === 'customer_service_sessions') row.status = 'closed';
  if (key === 'ccc_conversation_annotations') row.id = `${row.customer_id}:${row.employee_id}`;
  if (key === 'rating_requests') row.status = 'completed';
  if (key === 'service_ratings') row.rating = 5;
  if (key === 'notification_automation_plans') row.status = 'active';
  if (key === 'notification_automation_tasks') Object.assign(row, { status: 'active', trigger_type: 'total_orders', trigger_mode: 'reach_once', recipient_scope: 'selected' });
  if (key === 'notification_automation_plan_members') row.id = row.user_id;
  if (['notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_failures'].includes(key)) row.id = `${row.task_id}:${row.user_id}`;
  if (key === 'notification_automation_progress') row.last_period_key = 'all';
  if (key === 'notification_automation_executions') Object.assign(row, { status: 'succeeded', period_key: 'all', task_version: 1, error_message: null,
    trigger_snapshot: { trigger_type: 'total_orders', trigger_mode: 'reach_once', threshold_value: '__precise__', minimum_daily_orders: null, minimum_daily_work_minutes: null } });
  if (key === 'notification_automation_date_runs') Object.assign(row, { period_key: 'all', task_version: 1, id: `${row.task_id}:0000000001:all` });
  if (key === 'notification_automation_failures') row.last_error = 'redacted migration error';
  if (['messages', 'message_templates', 'notification_automation_tasks'].includes(key)) Object.assign(row, { message_type: 'realtime', priority: 'normal', delivery_mode: 'realtime_only' });
  if (key === 'messages') Object.assign(row, { notification_category: 'standard', audit_origin: 'manual_admin' });
  if (key === 'message_recipients') row.delivery_channel = 'realtime';
  if (key === 'broadcast_messages') Object.assign(row, { message_type: 'text', target_type: 'specific_employees' });
  if (key === 'content_audit_events') Object.assign(row, { before_data: null, before_data_sql_null: true, after_data: null, after_data_sql_null: false, media_refs: [] });
  if (key === 'content_audit_recipient_versions') row.id = `${row.message_id}:${row.recipient_id}`;
  if (key === 'administrators') Object.assign(row, { role: 'secondary_admin', parent_id: OTHER, updated_at: null });
  return row;
}
function serialize(row) { return JSON.stringify(row).replaceAll('"__precise__"', PRECISE).replaceAll('"__tiny__"', TINY).replace('"id":', '"\\u0069d":') + ' \r\n'; }
function texts(empty = false) {
  return Object.fromEntries(TABLES.map(key => [key, empty && key !== 'accounts' ? '' : Array.from({ length: ['wallet_ledger_entries', 'wallet_reconciliation_audit'].includes(key) ? 4
    : key === 'employee_login_history' ? 3 : ['orders', 'orders_history', 'customer_employee_conversations'].includes(key) ? 2 : 1 }, (_, i) => serialize(rowObject(key, i))).join('')]));
}
function catalog(text) {
  return { version: 1, protocol: 'employee-safety-records-v1', scope: 'employee-safety-records', job_id: JOB, site_id: SITE, employee_id: EMPLOYEE, username: NAME,
    tables: TABLES.map(key => ({ key, rows: lines(text[key]).length, bytes: Buffer.byteLength(text[key]), row_hashes_sha256: rowHash(text[key]) })), fingerprint: '2'.repeat(64), ...flags };
}
const info = () => ({ exportId: randomUUID(), volumeId: randomUUID(), sourceSiteId: SITE, scope: 'replacement-backup', volumeIndex: 1, volumeCount: 1, createdAt: '2026-10-21T00:00:00.000Z' });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'employee-safety-client-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const h = { directory, session: SESSION, tokenReads: 0, calls: [], events: [], workspaces: [], text: texts(options.empty), info: info(),
    writes: 0, opens: 0, verifyCount: 0, transform: null, rpcHook: null, workspaceHook: null, cleanupHook: null, fileWriteHook: null, fileReadHook: null, options };
  h.catalog = catalog(h.text);
  h.reply = (name, args) => {
    if (name === BEGIN) return { success: true, job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: structuredClone(h.catalog), scope: 'employee-safety-records', full_site_complete: false };
    if (name === CATALOG) return structuredClone(h.catalog);
    assert.equal(args.p_catalog_fingerprint, h.catalog.fingerprint);
    if (name === CLOSE) return { success: true, scope: 'employee-safety-records', full_site_complete: false };
    if (name === VERIFY) { h.verifyCount++; return { verified: true, fingerprint: h.catalog.fingerprint, ...flags }; }
    assert.equal(name, PAGE); assert.equal(args.p_limit, 200);
    const all = lines(h.text[args.p_table_key]), start = args.p_after === null ? 0 : all.findIndex(line => JSON.parse(line).id === args.p_after) + 1;
    assert.ok(args.p_after === null || start > 0);
    const selected = all.slice(start, start + (options.pageSize ?? 200)), ndjson = selected.join('');
    return { table_key: args.p_table_key, count: selected.length, bytes: Buffer.byteLength(ndjson), ndjson,
      next_after: start + selected.length < all.length ? JSON.parse(selected.at(-1)).id : null, sha256: sha(ndjson), fingerprint: h.catalog.fingerprint };
  };
  h.rpc = (name, args) => {
    assert.ok([BEGIN, CATALOG, PAGE, VERIFY, CLOSE].includes(name)); assert.equal(args.p_admin_session_token, h.session);
    assert.deepEqual(Object.keys(args).sort(), (name === BEGIN ? ['p_admin_session_token', 'p_admin_password', 'p_username'] : name === CATALOG ? ['p_admin_session_token', 'p_job_token']
      : name === PAGE ? ['p_admin_session_token', 'p_job_token', 'p_catalog_fingerprint', 'p_table_key', 'p_after', 'p_limit'] : ['p_admin_session_token', 'p_job_token', 'p_catalog_fingerprint']).sort());
    if (name === BEGIN) { assert.equal(args.p_username, h.catalog.username); assert.equal(args.p_admin_password, SECRET); }
    else assert.equal(args.p_job_token, TOKEN);
    const query = { signal: undefined, abortSignal(signal) { query.signal = signal; return query; }, then(resolve, reject) {
      return Promise.resolve().then(async () => {
        h.calls.push({ name, args: structuredClone(args), signal: query.signal }); h.events.push(name);
        if (h.rpcHook) await h.rpcHook(name, args, query.signal);
        const value = h.reply(name, args); return { data: h.transform ? await h.transform(name, value, args) : value, error: null };
      }).then(resolve, reject);
    } }; return query;
  };
  h.createWorkspace = () => {
    const base = join(directory, `workspace-${h.workspaces.length}`);
    const w = { base, cleaned: false, cleanups: 0,
      async append(path, bytes, signal) {
        assert.equal(w.cleaned, false); assert.equal(signal?.aborted, false);
        assert.ok(path === CATALOG_PATH || TABLES.some(key => path === api.employeeSafetyBackupEntryPath(key)));
        if (h.workspaceHook) await h.workspaceHook(w, path, bytes, signal);
        assert.equal(w.cleaned, false); await mkdir(dirname(join(base, path)), { recursive: true });
        assert.equal(w.cleaned, false); await appendFile(join(base, path), bytes);
      },
      open(path) { return { async *[Symbol.asyncIterator]() {
        assert.equal(w.cleaned, false);
        for await (const raw of createReadStream(join(base, path), { highWaterMark: 137 })) { assert.equal(w.cleaned, false); yield raw; }
      } }; },
      async abort() { w.cleaned = true; w.cleanups++; h.events.push(`cleanup-${h.workspaces.indexOf(w)}`);
        await rm(base, { recursive: true, force: true }); if (h.cleanupHook) await h.cleanupHook(w); },
    }; h.workspaces.push(w); return w;
  };
  h.filePath = join(directory, 'independent.edx');
  h.file = {
    async write(source, signal) {
      h.writes++; h.events.push('file-write');
      if (options.shortWrite) { for await (const raw of source) { assert.ok(raw.length); break; } return; }
      const handle = await open(h.filePath, 'wx');
      try { for await (const raw of source) { assert.equal(signal.aborted, false); await handle.writeFile(raw); } await handle.sync(); }
      finally { await handle.close(); }
      if (h.fileWriteHook) await h.fileWriteHook(signal);
    },
    open() { h.opens++; h.events.push('file-open'); if (h.fileReadHook) return h.fileReadHook(); return { async *[Symbol.asyncIterator]() {
      for await (const raw of createReadStream(h.filePath, { highWaterMark: 113 })) yield raw; h.events.push('file-eof');
    } }; },
  };
  h.connect = () => { api.setHarness(h); return api.createEmployeeSafetyBackupSession(h.catalog.username, SECRET); };
  h.start = async () => { const session = h.connect(); await session.begin(); return session; };
  h.export = async (options = {}) => { const session = await h.start(); h.client = session; return api.exportEmployeeSafetyBackup(session, h.file, h.createWorkspace, PASS, h.info, options); };
  h.read = (consume, options = {}, pass = PASS) => api.withAuthenticatedEmployeeSafetyBackup(h.file, pass, h.createWorkspace, consume, options);
  h.refresh = () => { h.catalog = catalog(h.text); };
  return h;
}
async function collect(source) { const chunks = []; for await (const raw of source) chunks.push(Buffer.from(raw)); return Buffer.concat(chunks); }
function redacted(error, phase) {
  assert.ok(error instanceof api.EmployeeSafetyBackupError); if (phase) assert.equal(error.phase, phase);
  assert.equal(inspect(error).includes(SECRET), false); assert.equal('cause' in error, false); assert.match(error.message, /not a complete employee backup/); return true;
}
function cleaned(h) { for (const w of h.workspaces) { assert.equal(w.cleaned, true); assert.equal(w.cleanups, 1); } }
async function rejected(h, options = {}, check) { await assert.rejects(h.export(options), e => { redacted(e); check?.(e); return true; }); cleaned(h); assert.equal(h.calls.some(c => c.name === CLOSE), false); }
async function writeBundle(h, changes = {}) {
  const text = changes.text ?? h.text, c = changes.catalog ?? catalog(text), metadata = changes.info ?? h.info;
  async function* entries() {
    for (const key of TABLES) {
      if (changes.omit === key) continue;
      const raw = Buffer.from(text[key]); yield { path: api.employeeSafetyBackupEntryPath(key), bytes: raw.length, open: () => ({ async *[Symbol.asyncIterator]() { yield raw; } }) };
    }
    const raw = Buffer.from(changes.catalogRaw ?? JSON.stringify(c) + '\n');
    yield { path: CATALOG_PATH, bytes: raw.length, open: () => ({ async *[Symbol.asyncIterator]() { yield raw; } }) };
    if (changes.extra) yield { path: 'data/extra.ndjson', bytes: 0, open: () => ({ async *[Symbol.asyncIterator]() {} }) };
  }
  await h.file.write(api.writeEncryptedVolume(entries(), metadata, PASS), new AbortController().signal);
}

// Keep this focused suite within 100 cases; grouped assertions do not inflate test counts.
test('synthetic RPC bridge + REAL encrypted disk roundtrip preserves every one of the 48 raw tables', async t => {
  const h = fixture(t, { pageSize: 2 }), result = await h.export();
  assert.equal(TABLES.length, 48); assert.equal(new Set(TABLES).size, 48);
  assert.deepEqual(TABLES, [...api.EMPLOYEE_BACKUP_TABLE_KEYS, ...api.CHAT_TABLE_KEYS, ...api.NOTIFICATIONS_TABLE_KEYS,
    'dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'valid_order_data', 'used_order_data',
    'content_audit_events', 'content_audit_recipient_versions', 'orders_history', 'administrators']);
  assert.equal(result.recordsVerified, true); for (const [key, value] of Object.entries(flags)) assert.equal(result[key], value);
  for (const key of ['completeEmployeeBackup', 'canArchive', 'canReplace', 'fullSiteComplete', 'mediaIncluded']) assert.equal(result[key], false);
  assert.equal(h.verifyCount, 2); assert.equal(h.writes, 1); assert.equal(h.opens, 1); cleaned(h);
  assert.equal(h.tokenReads, h.calls.length); assert.equal(h.calls.some(c => c.name === CLOSE), false);
  const disk = await readFile(h.filePath); assert.equal(result.cipherBytes, disk.length); assert.equal(result.cipherSha256, sha(disk));
  assert.equal(disk.includes(Buffer.from(PRECISE)), false); assert.equal(disk.includes(Buffer.from('$2a$hash')), false);
  assert.deepEqual(result.manifest.entries.map(e => e.path), [...TABLES.map(api.employeeSafetyBackupEntryPath), CATALOG_PATH]);
  const calls = h.calls.length; let expired, deferred;
  await h.read(async reader => {
    expired = reader; deferred = reader.open(api.employeeSafetyBackupEntryPath('accounts'));
    assert.equal(Object.hasOwn(reader, 'append'), false); assert.deepEqual(reader.catalog, h.catalog);
    const changed = reader.catalog; changed.username = 'changed'; assert.equal(reader.catalog.username, NAME);
    for (const key of TABLES) assert.equal((await collect(reader.open(api.employeeSafetyBackupEntryPath(key)))).toString(), h.text[key], key);
    assert.match(h.text.wallet_transactions, /12345678901234567890\.12345678901234567890/);
    assert.match(h.text.employee_login_history, /"device_info_is_sql_null":true/); assert.match(h.text.employee_login_history, /"device_info_is_sql_null":false/);
    assert.match(h.text.customer_employee_conversations, /"rating_data_sql_null":false/); assert.match(h.text.simulated_customers, /"target_employee_ids":\[null\]/);
    assert.match(h.text.content_audit_events, /"before_data_sql_null":true/); assert.match(h.text.content_audit_events, /"after_data_sql_null":false/);
    const history = lines((await collect(reader.open(api.employeeSafetyBackupEntryPath('orders_history')))).toString()).map(JSON.parse);
    for (const row of history) assert.deepEqual(Object.keys(row), ['id', 'user_id', 'status', 'commission_amount', 'created_at', 'completed_at']);
    assert.equal(history[0].completed_at, TIME); assert.equal(history[1].completed_at, null); assert.equal(history[1].created_at, null); assert.equal(history[1].commission_amount, null);
    assert.match(h.text.orders_history, /"commission_amount":12345678901234567890\.12345678901234567890/);
    assert.match(h.text.orders_history, /"completed_at":"2024-02-29T23:34:56\.123456\+00:00"/);
    assert.deepEqual(Object.keys(JSON.parse(lines(h.text.orders)[0])), ['id', 'user_id', 'status', 'commission_amount', 'commission_rate', 'created_at', 'processed_at']);
    assert.deepEqual(Object.keys(JSON.parse(h.text.administrators)), ['id', 'username', 'role', 'parent_id', 'created_at', 'updated_at']);
    assert.throws(() => reader.open('media/any/file.png')); return 123;
  }, { expectedMetadata: { exportId: h.info.exportId, volumeId: h.info.volumeId } });
  assert.equal(h.calls.length, calls); assert.throws(() => expired.catalog); assert.throws(() => expired.open(CATALOG_PATH)); await assert.rejects(collect(deferred)); cleaned(h);
  const events = h.events; assert.ok(events.indexOf(VERIFY) < events.indexOf('file-write'));
  assert.ok(events.indexOf('cleanup-0') < events.indexOf('file-open')); assert.ok(events.indexOf('file-eof') < events.lastIndexOf(VERIFY));
  assert.ok(events.indexOf('cleanup-1') > events.lastIndexOf(VERIFY));
  await h.client.close(result.catalog); assert.equal(h.calls.at(-1).name, CLOSE);
  await assert.rejects(h.client.close(result.catalog)); assert.equal(h.calls.filter(c => c.name === CLOSE).length, 1);
});
test('all 47 optional tables empty still requires the single account and all 49 entries', async t => {
  const h = fixture(t, { empty: true }), result = await h.export(); assert.equal(result.rows, 1);
  await h.read(async reader => { for (const key of TABLES.filter(key => key !== 'accounts')) assert.equal((await collect(reader.open(api.employeeSafetyBackupEntryPath(key)))).length, 0); }); cleaned(h);
});
test('real multi-page 205 rows and numeric bigint order preserve raw bytes and counts', async t => {
  const h = fixture(t); h.text.employee_login_history = Array.from({ length: 205 }, (_, i) => serialize(rowObject('employee_login_history', i))).join(''); h.refresh();
  const result = await h.export(); assert.equal(h.calls.filter(c => c.name === PAGE && c.args.p_table_key === 'employee_login_history').length, 2);
  await h.read(async reader => { assert.equal((await collect(reader.open(api.employeeSafetyBackupEntryPath('employee_login_history')))).toString(), h.text.employee_login_history); });
  assert.equal(result.rows, h.catalog.tables.reduce((n, t) => n + t.rows, 0)); cleaned(h);
});
test('session requires explicit begin and export cleanup before explicit close; identity is immutable and no target UUID is sent', async t => {
  const h = fixture(t), session = h.connect(); assert.equal(session.identity(), null); assert.equal(h.calls.length, 0);
  await assert.rejects(session.catalog()); await assert.rejects(session.page(h.catalog, 'accounts', null)); await assert.rejects(session.verify(h.catalog)); assert.equal(h.calls.length, 0);
  const started = await session.begin(); assert.equal(started.catalog.username, NAME); assert.equal(session.identity().employee_id, EMPLOYEE); assert.ok(Object.isFrozen(session.identity()));
  started.catalog.username = 'modified'; assert.equal((await session.catalog()).username, NAME);
  await assert.rejects(session.close(h.catalog)); await assert.rejects(session.begin()); assert.equal(h.calls.filter(c => c.name === BEGIN).length, 1);
});
test('every API call reacquires the current admin token after re-login', async t => {
  const h = fixture(t), session = await h.start(); h.session = OTHER; await session.catalog(); await session.page(h.catalog, 'accounts', null); await session.verify(h.catalog);
  assert.equal(h.tokenReads, h.calls.length); assert.equal(h.calls[1].args.p_admin_session_token, OTHER);
});
test('username rejects surrounding whitespace without trimming, retains case/Unicode and code-point length 1..256', async t => {
  const h = fixture(t);
  for (const name of ['', '  ', ` ${NAME}`, `${NAME} `, `  ${NAME}  `, `\t${NAME}`, `${NAME}\n`, `\u00a0${NAME}`, 'x'.repeat(257), '\ud800', 'a\0b']) {
    assert.throws(() => api.createEmployeeSafetyBackupSession(name, SECRET));
  }
  assert.equal(h.calls.length, 0);
  for (const name of ['A', 'x'.repeat(256), '𠮷'.repeat(256)]) { h.catalog.username = name; const s = h.connect(); assert.equal((await s.begin()).catalog.username, name); }
  h.catalog = catalog(h.text); h.transform = (name, value) => { if (name === BEGIN) value.catalog.username = NAME.toLowerCase(); return value; };
  await assert.rejects(h.connect().begin(), e => redacted(e, 'begin'));
});
for (const [label, change] of [
  ['failure receipt', () => ({ success: false, error: SECRET })], ['backend error', () => { throw new Error(SECRET); }],
  ['wrong job', v => ({ ...v, job_id: OTHER })], ['wrong site', v => ({ ...v, site_id: OTHER })],
]) test(`begin is never retried after ${label} (synthetic RPC)`, async t => {
  const h = fixture(t); h.transform = (name, value) => name === BEGIN ? change(value) : value; const s = h.connect();
  await assert.rejects(s.begin(), e => redacted(e, 'begin')); await assert.rejects(s.begin()); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, BEGIN);
});
test('busy session rejects overlapping RPC and does not retry a suspended begin', async t => {
  const h = fixture(t); let release; h.rpcHook = () => new Promise(resolve => { release = resolve; }); const s = h.connect(), pending = s.begin();
  while (!release) await new Promise(resolve => setTimeout(resolve, 1)); await assert.rejects(s.begin()); release(); await pending; assert.equal(h.calls.length, 1);
});

const associated = TABLES.filter(key => Object.keys(projections[key]).some(field => ['user_id', 'employee_id', 'recipient_id'].includes(field)) && key !== 'accounts');
for (const key of associated) test(`reject foreign employee association in ${key}`, () => {
  const raw = texts(), c = catalog(raw), value = rowObject(key), field = ['user_id', 'employee_id', 'recipient_id'].find(field => Object.hasOwn(value, field));
  value[field] = OTHER;
  if (key === 'notification_automation_plan_members') value.id = OTHER;
  if (['notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_failures'].includes(key)) value.id = `${value.task_id}:${OTHER}`;
  if (key === 'ccc_conversation_annotations') value.id = `${value.customer_id}:${OTHER}`;
  if (key === 'content_audit_recipient_versions') value.id = `${value.message_id}:${OTHER}`;
  assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize(value), key, c));
});
for (const [label, mutate] of [
  ['missing table', c => c.tables.pop()], ['reordered tables', c => c.tables.reverse()], ['extra table', c => c.tables.push(c.tables[0])],
  ['extra target UUID field', c => { c.target_employee_id = OTHER; }], ['wrong protocol', c => { c.protocol = 'replacement-records-v1'; }],
  ['wrong scope', c => { c.scope = 'employee-replacement-records'; }], ['account absent', c => { c.tables[0].rows = 0; c.tables[0].bytes = 0; c.tables[0].row_hashes_sha256 = sha(''); }],
  ['row limit', c => { c.tables[1].rows = 500001; }], ['table byte limit', c => { c.tables[2].bytes = 268435457; }],
  ['total GiB limit', c => { for (const table of c.tables.slice(1, 6)) { table.rows = 500000; table.bytes = 268435456; } }],
  ['bad fingerprint', c => { c.fingerprint += '\n'; }], ['row hash malformed', c => { c.tables[0].row_hashes_sha256 = 'z'.repeat(64); }],
  ['unsafe archive permission', c => { c.can_archive = true; }], ['fake complete backup', c => { c.complete_employee_backup = true; }],
  ['getter', c => Object.defineProperty(c, 'username', { get() { assert.fail('getter executed'); }, enumerable: true })],
]) test(`catalog rejects ${label}`, () => { const c = catalog(texts()); mutate(c); assert.throws(() => api.validateEmployeeSafetyBackupCatalog(c)); });

test('catalog flags are exact and plain arrays reject sparse/accessor/extra properties', () => {
  for (const [key, value] of Object.entries(flags)) { const c = catalog(texts()); c[key] = !value; assert.throws(() => api.validateEmployeeSafetyBackupCatalog(c)); }
  for (const modify of [c => { delete c.tables[2]; }, c => { c.tables.extra = 1; }, c => Object.defineProperty(c.tables, '2', { get() { assert.fail('getter'); }, enumerable: true })]) {
    const c = catalog(texts()); modify(c); assert.throws(() => api.validateEmployeeSafetyBackupCatalog(c));
  }
});
test('fixed rows reject unknown/password columns, duplicate keys, wrong core account and core device secrets', () => {
  const c = catalog(texts());
  for (const key of ['administrators', 'orders_history', 'accounts', 'messages', 'dispatch_config', 'content_audit_events']) {
    const value = rowObject(key); value.password = SECRET; assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize(value), key, c));
    const line = serialize(rowObject(key)).replace('{', '{"id":"' + OTHER + '",'); assert.throws(() => api.validateEmployeeSafetyBackupRow(line, key, c));
  }
  const history = rowObject('orders_history');
  assert.equal(api.validateEmployeeSafetyBackupRow(serialize(history), 'orders_history', c), history.id);
  for (const field of ['commission_rate', 'processed_at']) {
    assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize({ ...history, [field]: null }), 'orders_history', c));
  }
  const missingCompleted = { ...history }; delete missingCompleted.completed_at;
  assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize(missingCompleted), 'orders_history', c));
  assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize({ ...history, completed_at: false }), 'orders_history', c));
  assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize(rowObject('orders')), 'orders_history', c));
  assert.deepEqual(Object.keys(api.EMPLOYEE_BACKUP_PROJECTIONS.orders), ['id', 'user_id', 'status', 'commission_amount', 'commission_rate', 'created_at', 'processed_at']);
  const account = rowObject('accounts'); account.username = NAME.toLowerCase(); assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize(account), 'accounts', c));
  const login = rowObject('employee_login_history', 2); login.device_info = { nested: { accessToken: SECRET } }; assert.throws(() => api.validateEmployeeSafetyBackupRow(serialize(login), 'employee_login_history', c));
});
test('shared definitions retain target visibility [null]/[UUID,null], no association expansion or normalization', () => {
  const c = catalog(texts()), role = rowObject('simulated_customers');
  for (const v of [null, [], [null], [OTHER, null]]) { role.target_employee_ids = v; api.validateEmployeeSafetyBackupRow(serialize(role), 'simulated_customers', c); }
});
for (const [label, patch] of [
  ['wrong table', p => { p.table_key = 'credentials'; }], ['wrong fingerprint', p => { p.fingerprint = '0'.repeat(64); }],
  ['count mismatch', p => { p.count++; }], ['byte mismatch', p => { p.bytes++; }], ['bad hash', p => { p.sha256 = '0'.repeat(64); }],
  ['cursor mismatch', p => { p.next_after = OTHER; }], ['missing LF', p => { p.ndjson = p.ndjson.trimEnd(); p.bytes = Buffer.byteLength(p.ndjson); p.sha256 = sha(p.ndjson); }],
]) test(`page rejects ${label}`, t => { const h = fixture(t), p = h.reply(PAGE, { p_table_key: 'accounts', p_after: null, p_limit: 200, p_catalog_fingerprint: h.catalog.fingerprint });
  patch(p); assert.throws(() => api.validateEmployeeSafetyBackupPage(p, h.catalog, 'accounts', null));
});
test('page bounds reject 201 rows, >256KiB page, >64KiB line and repeated/reversed IDs', t => {
  const h = fixture(t), c = h.catalog;
  for (const text of [Array.from({ length: 201 }, (_, i) => serialize(rowObject('orders', i))).join(''), serialize({ ...rowObject('orders'), status: 'x'.repeat(65536) }),
    Array.from({ length: 5 }, (_, i) => serialize({ ...rowObject('orders', i), status: 'x'.repeat(60000) })).join(''),
    serialize(rowObject('orders', 1)) + serialize(rowObject('orders', 0)), serialize(rowObject('orders', 0)).repeat(2)]) {
    const p = { table_key: 'orders', count: lines(text).length, bytes: Buffer.byteLength(text), ndjson: text, next_after: null, sha256: sha(text), fingerprint: c.fingerprint };
    assert.throws(() => api.validateEmployeeSafetyBackupPage(p, c, 'orders', null));
  }
});
for (const [label, update] of [
  ['job UUID reused', i => { i.exportId = JOB; }], ['employee UUID reused', i => { i.exportId = EMPLOYEE; }], ['wrong source site', i => { i.sourceSiteId = OTHER; }],
  ['not UUIDv4', i => { i.exportId = 'a9000000-0000-1000-8000-000000000009'; }], ['multiple volumes', i => { i.volumeCount = 2; }],
]) test(`export metadata rejects ${label} before file write`, async t => { const h = fixture(t); update(h.info); await rejected(h); assert.equal(h.writes, 0); });
test('tighter payload cap fails without truncating, writing or closing', async t => { const h = fixture(t); await rejected(h, { limits: { maxTotalBytes: 1 } }); assert.equal(h.writes, 0); });
test('ordered row hash drift rejects even when page hash/bytes/count are internally correct', async t => {
  const h = fixture(t); h.text.accounts = h.text.accounts.replace('原始備註', '同量變更'); await rejected(h); assert.equal(h.writes, 0);
});
test('source verification failure rejects before saving and never auto-closes', async t => {
  const h = fixture(t); h.transform = (name, value) => name === VERIFY ? { ...value, verified: false } : value; await rejected(h, {}, e => assert.equal(e.phase, 'source-recheck')); assert.equal(h.writes, 0);
});
test('final verification drift keeps saved file but refuses close/backup success', async t => {
  const h = fixture(t); h.transform = (name, value) => name === VERIFY && h.verifyCount === 2 ? { ...value, fingerprint: '0'.repeat(64) } : value;
  await rejected(h, {}, e => { assert.equal(e.phase, 'target-recheck'); assert.equal(e.encryptedFileState, 'verified'); });
  await assert.rejects(h.client.close(h.catalog)); assert.ok((await readFile(h.filePath)).length);
});
test('short write does not fake persisted EOF or close', async t => { const h = fixture(t, { shortWrite: true }); await rejected(h, {}, e => { assert.equal(e.phase, 'save'); assert.equal(e.outcomeUnknown, true); }); });
test('file write rejection redacts secrets and retains ambiguous persisted ciphertext', async t => {
  const h = fixture(t); h.fileWriteHook = () => { throw new Error(SECRET); }; await rejected(h, {}, e => { assert.equal(e.encryptedFileState, 'unknown'); assert.equal(e.outcomeUnknown, true); }); assert.ok((await readFile(h.filePath)).length);
});
test('actual saved cipher tamper is detected before final verification', async t => {
  const h = fixture(t); h.fileWriteHook = async () => { const raw = await readFile(h.filePath); raw[raw.length - 10] ^= 1; await writeFile(h.filePath, raw); };
  await rejected(h, {}, e => assert.equal(e.phase, 'authenticate')); assert.equal(h.verifyCount, 1);
});
test('wrong passphrase/truncated/tampered ciphertext never exposes plaintext to consume', async t => {
  const h = fixture(t); await h.export(); let called = 0;
  await assert.rejects(h.read(async () => { called++; }, {}, 'wrong passphrase'), e => redacted(e, 'authenticate'));
  const raw = await readFile(h.filePath);
  for (const changed of [raw.subarray(0, raw.length - 1), Buffer.concat([raw, Buffer.from([1])]), Buffer.from(raw)]) {
    if (changed.length === raw.length) changed[Math.floor(changed.length / 2)] ^= 1;
    await writeFile(h.filePath, changed); await assert.rejects(h.read(async () => { called++; }), e => redacted(e));
  }
  assert.equal(called, 0); cleaned(h);
});
test('independent reader rejects wrong expected metadata without any RPC', async t => {
  const h = fixture(t); await writeBundle(h); await assert.rejects(h.read(async () => assert.fail('consume'), { expectedMetadata: { exportId: OTHER, volumeId: h.info.volumeId } })); assert.equal(h.calls.length, 0); cleaned(h);
});
for (const [label, changes] of [
  ['missing entry', h => ({ omit: 'credentials' })], ['extra entry', () => ({ extra: true })],
  ['wrong employee', h => ({ catalog: { ...h.catalog, employee_id: OTHER } })], ['wrong username', h => ({ catalog: { ...h.catalog, username: 'changed' } })],
  ['wrong row hash', h => ({ catalog: { ...h.catalog, tables: h.catalog.tables.map((t, i) => i === 47 ? { ...t, row_hashes_sha256: '0'.repeat(64) } : t) } })],
  ['foreign recipient', h => { const text = { ...h.text, message_recipients: serialize({ ...rowObject('message_recipients'), recipient_id: OTHER }) }; return { text }; }],
  ['noncanonical duplicate catalog', h => ({ catalogRaw: JSON.stringify(h.catalog).replace('{', '{"version":1,') + '\n' })],
]) test(`fully authenticated but invalid independent bundle rejects ${label} before consume`, async t => {
  const h = fixture(t); await writeBundle(h, changes(h)); let called = false;
  await assert.rejects(h.read(async () => { called = true; }), e => redacted(e, label === 'extra entry' ? 'authenticate' : 'validate')); assert.equal(called, false); assert.equal(h.calls.length, 0); cleaned(h);
});
test('consumer exception is redacted, reader expires and all real plaintext directories are removed', async t => {
  const h = fixture(t); await writeBundle(h); let reader;
  await assert.rejects(h.read(async r => { reader = r; throw new Error(SECRET); }), e => redacted(e, 'consume')); assert.throws(() => reader.open(CATALOG_PATH)); cleaned(h);
});
for (const phase of ['records-export', 'source-recheck', 'save', 'authenticate', 'target-recheck']) test(`cancellation during ${phase} cleans and never closes`, async t => {
  const h = fixture(t), controller = new AbortController(); await rejected(h, { signal: controller.signal, onProgress(p) { if (p.phase === phase) controller.abort(); } }, e => assert.equal(e.cancelled, true));
});
test('cancel a blocked page immediately, ignore late response and never resume disk writes', async t => {
  const h = fixture(t), session = await h.start(), controller = new AbortController(); let release;
  h.rpcHook = name => name === PAGE ? new Promise(resolve => { release = resolve; }) : undefined;
  const task = api.exportEmployeeSafetyBackup(session, h.file, h.createWorkspace, PASS, h.info, { signal: controller.signal });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1)); controller.abort(); await assert.rejects(task, e => { redacted(e); assert.equal(e.cancelled, true); return true; });
  release(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(h.writes, 0); cleaned(h);
});
test('local reader cancellation before auth and during consume invalidates delayed readers', async t => {
  const h = fixture(t); await writeBundle(h); let controller = new AbortController(); controller.abort();
  await assert.rejects(h.read(async () => assert.fail('consume'), { signal: controller.signal }), e => { assert.equal(e.cancelled, true); return true; });
  controller = new AbortController(); let stale;
  await assert.rejects(h.read(async r => { stale = r.open(CATALOG_PATH); controller.abort(); await new Promise(() => {}); }, { signal: controller.signal }), e => { assert.equal(e.cancelled, true); return true; });
  await assert.rejects(collect(stale)); cleaned(h);
});
test('export cleanup failure is explicit and blocks close even with authenticated ciphertext', async t => {
  const h = fixture(t); h.cleanupHook = w => { if (h.workspaces.indexOf(w) === 1) throw new Error(SECRET); };
  await rejected(h, {}, e => { assert.equal(e.cleanupRequired, true); assert.equal(e.encryptedFileState, 'verified'); }); await assert.rejects(h.client.close(h.catalog));
});
test('independent reader cleanup failure overrides successful consumer result without leaking secrets', async t => {
  const h = fixture(t); await writeBundle(h); h.cleanupHook = () => { throw new Error(SECRET); };
  await assert.rejects(h.read(async () => 'would-be-success'), e => { redacted(e); assert.equal(e.cleanupRequired, true); return true; }); cleaned(h);
});
test('cancellation during final cleanup is not a successful saved backup and does not authorize close', async t => {
  const h = fixture(t), controller = new AbortController(); h.cleanupHook = w => { if (h.workspaces.indexOf(w) === 1) controller.abort(); };
  await rejected(h, { signal: controller.signal }, e => assert.equal(e.cancelled, true)); await assert.rejects(h.client.close(h.catalog));
});
test('workspace reuse cannot masquerade as independent authenticated readback', async t => {
  const h = fixture(t), source = await h.start(), w = h.createWorkspace(); await assert.rejects(api.exportEmployeeSafetyBackup(source, h.file, () => w, PASS, h.info)); cleaned(h);
});
