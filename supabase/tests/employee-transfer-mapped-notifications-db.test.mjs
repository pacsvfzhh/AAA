import assert from 'node:assert/strict';
import { after, before, mock, test as registerTest } from 'node:test';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { access, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { createSites, adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { EXPECTED_REPLAY_FAILURES } from './support/replay-migrations.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// SQL54 contract tests: the first 59 cases are independent of the mapped-notifications client.
// Appended client integration cases use the actual client and anon RPCs; only response delivery is simulated.
// Real source exports, independent disk AES/ZIP shared/dispatch backups and public SQL48–53 RPCs
// establish positive prerequisites. Never insert jobs, identity maps, verified flags or backup proof.
// Direct postgres DML is only local source business fixtures or explicitly rollback-only corruption.
// Routine notifications have 1–3 rows/table; ONLY the dedicated date-runs case exceeds 200 rows.
// No HTTP/production services, real Storage, native PostgreSQL concurrency or performance claim.
// Missing SQL54 is a hard error, NOT a skip or a fallback implementation.
// Run disjoint numbered groups with EMPLOYEE_MAPPED_NOTIFICATIONS_DB_RANGE=1-20, etc.
// Excluded cases are not registered, not counted as passes; each group replays all migrations.
const MIGRATION = '20261102000054_prepare_mapped_notifications.sql';
const PREFIX = 'employee_import_mapped_notifications_';
const OPERATIONS = ['bind', 'stage', 'plan', 'status'];
const SCOPE = 'employee-mapped-notifications';
const CATALOG = 'mapped-notifications-catalog-v1';
const INPUT = 'mapped-notifications-in:';
const ZERO = '00000000-0000-0000-0000-000000000000';
const KEYS = [
  'notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients',
];
const TABLES = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'],
  finance: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'],
  activity: ['employee_login_history', 'work_sessions', 'work_stop_markers'],
  verification: ['verification_requests'], notifications: KEYS,
};
const CONFLICTS = ['source_employee_missing', 'source_admin_unmapped', 'source_reference_missing', 'source_scope_mismatch',
  'source_unique_collision', 'reward_link_mismatch', 'unfinished_execution', 'unsupported_date_runs',
  'mapped_reward_mismatch', 'notification_target_not_empty', 'notification_uuid_collision'];
const GATES = ['can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
const PENDING = ['configuration_pending', 'records_pending', 'media_pending', 'automation_pending'];
const COMMON_KEYS = ['scope', 'job_id', 'site_id', 'source_site_id', 'package_id', 'mapping_hash',
  'maintenance', 'dependencies_pending', 'financial_data_pending', ...GATES, ...PENDING];
const id = n => `54000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { one: id(1), two: id(2), branch: id(3), otherRoot: id(4), order: id(10), valid: id(11),
  login: id(20), work: id(21), verification: id(22), unrelated: id(99) };
const N = { plan: id(100), emptyPlan: id(101), task: id(110), annual: id(111), execution: id(120), historical: id(121),
  manual: id(130), automatic: id(131), ordinary: id(132), manualRecipient: id(140), autoRecipient: id(141),
  ordinaryRecipient: id(142), manualOperation: id(150), template: id(160), broadcast: id(170), broadcastRecipient: id(171) };
const EMPLOYEES = [S.one, S.two];
const BIG = '9007199254740993';
const PRECISE = '12345678901234567890.1234567890123456789';
const MANUAL_REWARD = '12.12345678901234567890123456789';
const AUTO_REWARD = '7.25';
const RAW_ERROR = 'synthetic private diagnostic: must not leave source';
const TIME = '2023-04-05T06:07:08.123456Z';
const sha = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const rangeText = process.env.EMPLOYEE_MAPPED_NOTIFICATIONS_DB_RANGE;
let range = null, caseNo = 0, selectedCases = 0;
if (rangeText !== undefined) {
  assert.match(rangeText, /^[1-9][0-9]*-[1-9][0-9]*$/);
  range = rangeText.split('-').map(Number);
  assert.ok(range.every(Number.isSafeInteger) && range[0] <= range[1]);
  console.log(`Explicit SQL54 range ${rangeText}; excluded cases are NOT counted as passed.`);
}
function test(name, fn) {
  const number = ++caseNo;
  if (range && (number < range[0] || number > range[1])) return;
  selectedCases++;
  return registerTest(`SQL54 #${number}: ${name}`, { timeout: 600000 }, fn);
}
function chunks(text, size = 200) {
  const result = []; let part = '', count = 0;
  for (const line of lines(text)) {
    if (count === size || Buffer.byteLength(part + line) > 262144) { result.push(part); part = ''; count = 0; }
    part += line; count++;
  }
  if (part || result.length === 0) result.push(part);
  return result;
}
let source, db, replay, session, sourceSession, branch, emergency, other, pkg, task, sharedTask;
let shared, dispatch, identity, finance, activity, verification, notifications, modules, bindings;
let preVerificationDump, readyDump;
let counter = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function on(site, name, args, role = 'anon') {
  const point = `mapped_notifications_rpc_${++counter}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return result;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
const rpc = (name, args, role) => on(db, name, args, role);
const call = (op, extra = {}, role = 'anon') => rpc(PREFIX + op, { ...auth(), ...extra }, role);
const bind = (input = notifications, extra = {}, role) => call('bind', { p_catalog: input.catalog, ...extra }, role);
const stageChunk = (key, no, text, extra = {}, role) => call('stage', { p_table_key: key, p_chunk_no: no, p_ndjson: text, ...extra }, role);
const plan = (extra = {}, role) => call('plan', extra, role);
const status = (key = null, no = null, extra = {}, role) => call('status', { p_table_key: key, p_chunk_no: no, ...extra }, role);
const argsFor = op => op === 'bind' ? { p_catalog: notifications.catalog }
  : op === 'stage' ? { p_table_key: 'messages', p_chunk_no: 0, p_ndjson: notifications.texts.messages }
    : op === 'status' ? { p_table_key: null, p_chunk_no: null } : {};
const summary = () => scalar(db, 'SELECT summary FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]);
async function transaction(fn, site = db, commit = false) {
  await site.exec('BEGIN');
  try { const result = await fn(); await site.exec(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
  catch (error) { await site.exec('ROLLBACK'); throw error; }
}
async function isolated(fn) {
  const point = `mapped_notifications_negative_${++counter}`;
  await db.exec(`SAVEPOINT ${point}`);
  try { return await fn(); }
  finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
}
async function withClone(dump, fn) {
  const previous = db;
  const site = new PGlite({ loadDataDir: dump, extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await site.waitReady; db = site;
  try { return await fn(); } finally { db = previous; await site.close(); }
}
// Rollback-only target business fixtures / negative corruption. Never manufacture transfer state.
// Preserve all original trigger modes, including ALWAYS/REPLICA, before calling any real RPC.
async function change(relation, sql, params = []) {
  const modes = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
  for (const t of modes) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
  const point = `mapped_notifications_change_${++counter}`;
  await db.exec(`SAVEPOINT ${point}`);
  try { return await rows(db, sql, params); }
  catch (error) { await db.exec(`ROLLBACK TO SAVEPOINT ${point}`); throw error; }
  finally {
    await db.exec(`RELEASE SAVEPOINT ${point}`);
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
  }
}
async function snapshot(site = db) {
  const names = (await rows(site, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(site, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,
    md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} r`).join(' UNION ALL '));
}
const triggers = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','private') ORDER BY 1,2,3`);
async function unchanged(fn) {
  const before = await snapshot(), modes = await triggers();
  const result = await fn();
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await triggers(), modes);
  return result;
}
async function denyAll(extra = {}) {
  await unchanged(async () => {
    for (const role of ['anon', 'authenticated']) for (const op of OPERATIONS)
      await assert.rejects(call(op, { ...argsFor(op), ...extra }, role));
  });
}
async function noLegacy() {
  const s = await summary();
  for (const key of ['identity_restore', 'dependency_restore', 'verified_identity_map', 'finance_catalog', 'finance_plan', 'finance_restore',
    'activity_catalog', 'activity_restore', 'verification_catalog', 'verification_restore', 'notifications_catalog', 'notifications_plan',
    'notification_restore', 'notification_media_files', 'notification_storage_origin']) assert.equal(s[key], undefined, key);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance WHERE job_id=$1', [task.job_id]), true);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE is_active'), 0);
}

async function capture(kind, limit = 200) {
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession,
    p_admin_password: PASSWORDS.root, ...(['identity', 'finance', 'activity', 'verification', 'notifications'].includes(kind) ? { p_package_id: pkg } : {}) });
  assert.equal(job.success, true);
  const texts = {}, pages = {};
  for (const key of TABLES[kind]) {
    texts[key] = ''; pages[key] = []; let after = null;
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: limit });
      assert.equal(page.sha256, sha(page.ndjson)); pages[key].push(lines(page.ndjson).length);
      texts[key] += page.ndjson; after = page.next_after;
    } while (after !== null);
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  return { catalog: job.catalog, texts, pages };
}
async function* readDisk(path) {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(65521);
    for (;;) { const part = await handle.read(bytes); if (!part.bytesRead) return; yield bytes.subarray(0, part.bytesRead); }
  } finally { await handle.close(); }
}
async function prepare(kind, input) {
  const job = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg, p_catalog: input.catalog });
  for (const key of TABLES[kind]) for (const [no, text] of chunks(input.texts[key]).entries())
    await rpc(`employee_import_${kind}_stage`, { ...auth(job), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const p = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job));
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(job));
  const dir = await mkdtemp(join(tmpdir(), 'employee-mapped-notifications-')), path = join(dir, `${kind}-independent.edx`), plain = new Map();
  let opens = 0;
  try {
    const result = await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(job))).catalog; },
      page(key, after) { return rpc(`get_employee_import_${kind}_backup_page`, { ...auth(job), p_table_key: key, p_after: after, p_limit: 200 }); },
      async verify() {
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(job)), descriptor);
        return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
      },
    }, {
      async append(name, bytes) { plain.set(name, [...plain.get(name) ?? [], Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) {
        const handle = await open(path, 'wx');
        try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      },
      open() { opens++; return readDisk(path); },
    }, {
      append(no, hex) { assert.equal(opens, 2); return rpc(`employee_import_${kind}_backup_append`, { ...auth(job), p_plan_hash: p.plan_hash, p_chunk_no: no, p_hex: hex }); },
      seal(hash, bytes) { return rpc(`employee_import_${kind}_backup_seal`, { ...auth(job), p_plan_hash: p.plan_hash, p_sha256: hash, p_bytes: bytes }); },
    }, 'local-notifications-independent-backup-passphrase');
    assert.equal(result.sealReceipt.success, true); assert.equal(opens, 2); assert.equal(plain.size, 0);
    assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), true);
    return { job, plan: p };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function restoreIdentities() {
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: identity.catalog });
  for (const key of TABLES.identity) for (const [no, text] of chunks(identity.texts[key]).entries())
    await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  bindings = {};
  for (const sourceId of EMPLOYEES) {
    const observed = await rpc('employee_import_identity_reservation_status', { ...auth(), p_source_id: sourceId });
    assert.equal(observed.reservation, null);
    const reserved = await rpc('employee_import_identity_reserve', { ...auth(), p_source_id: sourceId,
      p_source_fingerprint: observed.observed.source_fingerprint, p_target_fingerprint: observed.observed.target_fingerprint });
    assert.equal(reserved.candidate_available, true); assert.notEqual(reserved.reservation.target_id, sourceId);
    bindings[sourceId] = reserved.reservation;
  }
  for (const sourceId of EMPLOYEES) {
    const p = await rpc('employee_import_mapped_identity_plan', { ...auth(), p_source_id: sourceId });
    assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
    await rpc('employee_import_mapped_identity_core', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash });
    for (let no = 0; no < p.order_chunks; no++) await rpc('employee_import_mapped_identity_orders', { ...auth(), p_source_id: sourceId, p_chunk_no: no });
    assert.equal((await rpc('employee_import_mapped_identity_verify', { ...auth(), p_source_id: sourceId })).verified, true);
  }
}
async function restoreDependencies() {
  const p = await rpc('employee_import_mapped_dependency_plan', auth()); assert.equal(p.can_begin, true);
  await rpc('employee_import_mapped_dependency_begin', { ...auth(), p_plan_hash: p.plan_hash });
  for (const key of ['dispatch_group_members', 'used_order_data']) for (let no = 0; no < p.chunks[key]; no++)
    await rpc('employee_import_mapped_dependency_chunk', { ...auth(), p_table_key: key, p_chunk_no: no });
  assert.equal((await rpc('employee_import_mapped_dependency_verify', auth())).verified, true);
}
async function restoreMapped(kind, { applied = EMPLOYEES, verify = true } = {}) {
  const prefix = `employee_import_mapped_${kind}_`, input = { finance, activity, verification }[kind];
  await rpc(prefix + 'bind', { ...auth(), p_catalog: input.catalog });
  for (const key of TABLES[kind]) for (const [no, text] of chunks(input.texts[key]).entries())
    await rpc(prefix + 'stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  if (kind === 'verification') await rpc(prefix + 'media_bind', { ...auth(), p_files: [] });
  const p = await rpc(prefix + 'plan', auth()); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
  await rpc(prefix + 'begin', { ...auth(), p_plan_hash: p.plan_hash });
  for (const sourceId of applied) assert.equal((await rpc(prefix + 'apply', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash })).employee.applied, true);
  if (verify) assert.equal((await rpc(prefix + 'verify', auth())).verified, true);
}
async function seedNotifications() {
  // Source business setup only. Triggers/FKs remain enabled; actual bonus SQL creates the money.
  await source.query(`INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,status,activated_at,created_at,updated_at)
    VALUES($1,$3,'來源方案 Alpha','active','2020-01-01T00:00:00.123456Z','2019-01-01','2020-01-01'),
      ($2,$4,'無成員原文方案','archived',NULL,'2019-01-01','2020-01-01')`, [N.plan, N.emptyPlan, S.branch, NEW.root]);
  for (const [taskId, name, trigger, status, month, day] of [
    [N.task, '循環獎勵', 'total_orders', 'active', null, null], [N.annual, '年度日期', 'annual_date', 'paused', 2, 29],
  ]) await source.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,name,trigger_type,trigger_mode,threshold_value,
      annual_month,annual_day,plan_id,status,title_template,content_template,version,activated_at,starts_at,created_at,updated_at,
      reward_enabled,reward_amount,recipient_scope,delivery_mode)
    VALUES($1,$2,$3,$4,$5,CASE WHEN $4='annual_date' THEN 1 ELSE 10 END,$6,$7,$8,$9,'原標題𠮷','<p>原內容 {{employee_name}}</p>',7,
      '2020-01-02T03:04:05.123456Z','2020-01-01','2019-01-01','2020-01-02',true,$10::numeric,'selected','realtime_with_login_fallback')`,
  [taskId, S.branch, name, trigger, trigger === 'annual_date' ? 'reach_once' : 'recurring', month, day, N.plan, status, AUTO_REWARD]);
  await source.query(`INSERT INTO public.notification_automation_plan_members(plan_id,user_id,created_at) VALUES($1,$2,'2021-02-03T04:05:06.654321Z')`, [N.plan, S.one]);
  await source.query(`INSERT INTO public.notification_automation_task_recipients(task_id,user_id,created_at) VALUES($1,$2,'2021-02-03T04:05:06.654321Z')`, [N.task, S.one]);
  await source.query(`INSERT INTO public.notification_automation_progress(task_id,user_id,last_metric,last_stage,last_period_key,updated_at)
    VALUES($1,$2,$3::numeric,$4::bigint,'all_time','2023-01-01T00:00:00.123456Z')`, [N.task, S.one, PRECISE, BIG]);
  await source.query(`INSERT INTO public.notification_automation_date_runs(task_id,task_version,period_key,created_at)
    VALUES($1,7,'year-0001','2024-02-29T01:02:03.654321Z')`, [N.annual]);
  const snapshot = JSON.stringify({ trigger_type: 'total_orders', trigger_mode: 'recurring', threshold_value: 10,
    minimum_daily_orders: null, minimum_daily_work_minutes: null });
  await source.query(`INSERT INTO public.notification_automation_executions(id,task_id,task_version,owner_admin_id,user_id,employee_username,
      period_key,stage,actual_value,trigger_snapshot,title_snapshot,content_snapshot,reward_amount,reward_currency,status,executed_at,plan_id)
    VALUES($1,$2,7,$3,$4,'歷史名稱𠮷','all_time',$5::bigint,20,$6::jsonb,'原標題','原內容',$7::numeric,'USDC','processing',$8::timestamptz,$9)`,
  [N.execution, N.task, S.branch, S.one, BIG, snapshot, AUTO_REWARD, TIME, N.plan]);
  await source.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,notification_category,
      reward_amount,reward_currency,automation_execution_id,audit_origin,delivery_mode,created_at)
    VALUES($1,$4,'branch','手動獎勵',E'<p>手動𠮷 é é \\n</p>','login_popup','high','performance_reward',$5::numeric,'USDC',NULL,'manual_admin','login_only',$8::timestamptz),
      ($2,$4,'branch','自動獎勵','<p>循環獎勵</p>','realtime','normal','performance_reward',$6::numeric,'USDC',$7,'automation','realtime_with_login_fallback',$8::timestamptz),
      ($3,$4,'branch','普通原文','<p>普通原文</p>','realtime','normal','standard',NULL,NULL,NULL,'manual_admin','realtime_only',NULL)`,
  [N.manual, N.automatic, N.ordinary, S.branch, MANUAL_REWARD, AUTO_REWARD, N.execution, TIME]);
  await source.query(`INSERT INTO public.message_recipients(id,message_id,recipient_id,is_read,read_at,is_shown,shown_at,delivery_channel,delivered_at,delivery_sequence,
      delivery_claim_token,delivery_claim_channel,delivery_claim_until,delivery_completed_claim_token,created_at)
    VALUES($1,$4,$7,true,'2023-04-06T00:00:00.123456Z',true,$9::timestamptz,'login_popup',$9::timestamptz,$8::bigint,$10,'login_popup','2099-01-01',$11,$9::timestamptz),
      ($2,$5,$7,false,NULL,false,NULL,NULL,NULL,$8::bigint+1,NULL,NULL,NULL,NULL,$9::timestamptz),
      ($3,$6,$12,NULL,NULL,NULL,NULL,NULL,NULL,$8::bigint+2,NULL,NULL,NULL,NULL,NULL)`,
  [N.manualRecipient, N.autoRecipient, N.ordinaryRecipient, N.manual, N.automatic, N.ordinary, S.one, BIG, TIME, id(180), id(181), S.two]);
  await scalar(source, 'SELECT private.credit_performance_bonus($1,$2,$3::numeric,$4,$5,$6,$7)',
    [S.one, S.branch, MANUAL_REWARD, 'USDC', N.manualRecipient, N.manualOperation, 'local manual reward']);
  const bonus = await scalar(source, 'SELECT private.credit_performance_bonus($1,$2,$3::numeric,$4,$5,$6,$7)',
    [S.one, S.branch, AUTO_REWARD, 'USDC', N.autoRecipient, N.execution, 'local automatic reward']);
  await source.query(`UPDATE public.notification_automation_executions SET message_id=$2,wallet_transaction_id=$3,status='succeeded',
    completed_at='2023-04-05T06:08:09.000001Z' WHERE id=$1`, [N.execution, N.automatic, bonus]);
  await source.query(`INSERT INTO public.notification_automation_executions(id,task_version,employee_username,period_key,stage,actual_value,
      trigger_snapshot,title_snapshot,content_snapshot,status,error_message,executed_at,completed_at)
    VALUES($1,1,'可空歷史關聯','legacy',1,0,$2::jsonb,'歷史','歷史','failed',NULL,'2022-01-01',NULL)`, [N.historical, snapshot]);
  await source.query(`INSERT INTO public.notification_automation_failures(task_id,user_id,owner_admin_id,attempts,last_error,first_failed_at,last_failed_at)
    VALUES($1,$2,$3,3,$4,'2022-01-01T00:00:00.123456Z','2022-01-02T00:00:00.654321Z')`, [N.task, S.one, S.branch, RAW_ERROR]);
  await source.query(`INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority,sort_order,delivery_mode)
    VALUES($1,$2,'無收件人的範本','原標題','<p>範本𠮷</p>','realtime','urgent',9,'realtime_only')`, [N.template, NEW.root]);
  await source.query(`INSERT INTO public.broadcast_messages(id,admin_id,message_content,message_type,image_url,target_type,target_admin_id,sent_count,created_at)
    VALUES($1,NULL,'歷史廣播','text',NULL,'all',NULL,NULL,NULL)`, [N.broadcast]);
  await source.query(`INSERT INTO public.broadcast_recipients(id,broadcast_id,employee_id,is_read,read_at,created_at)
    VALUES($1,$2,$3,true,'2023-01-01T00:00:00.654321Z',NULL)`, [N.broadcastRecipient, N.broadcast, S.one]);
}

before(async () => {
  const migrationUrl = new URL(`../migrations/${MIGRATION}`, import.meta.url);
  await access(migrationUrl);
  console.log(`SQL54 migration SHA256 ${sha(await readFile(migrationUrl))}`);
  for (const [object, names] of [[globalThis, ['fetch']], [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [tls, ['connect']]])
    for (const name of names) mock.method(object, name, () => assert.fail('network/production services forbidden'));
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  console.log('SQL54 setup: strict 581-migration replay');
  replay = await createSites({ upTo: MIGRATION }); source = replay.oldSite; db = replay.newSite;
  assert.equal(replay.files.at(-1), MIGRATION);
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await source.query('DELETE FROM public.financial_admin_credentials WHERE admin_id=$1', [NEW.branch]);
  await source.query('UPDATE public.admins SET id=$1 WHERE id=$2', [S.branch, NEW.branch]);
  await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [S.branch]);
  for (const [sourceId, name, number, owner] of [[S.one, 'mapped-notifications-one', 'MN-001', S.branch], [S.two, 'mapped-notifications-two', 'MN-002', NEW.root]]) {
    await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,total_income,created_at)
      VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5,true,0,'2020-01-01T01:02:03.123456Z')`,
    [sourceId, name, number, PASSWORDS.employee, owner]);
    await source.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [sourceId]);
  }
  await source.query(`INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Mapped notifications historical product',false)`, [id(12)]);
  // The real snapshot_order_dispatch_rates trigger needs a live group membership before INSERT.
  await source.query('INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by) VALUES($1,$2,$3)', [NEW.groupA, S.one, S.branch]);
  await source.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,created_at)
    VALUES($1,$2,'mapped-notifications-one',$3,99,'LOCAL-MN-ORDER','LOCAL-MN-TX','failure','2021-01-01')`, [S.order, S.one, id(12)]);
  await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by) VALUES($1,99,'local-mn-valid',$2)`, [S.valid, S.branch]);
  await source.query('INSERT INTO public.used_order_data(user_id,valid_order_data_id,order_id) VALUES($1,$2,$3)', [S.one, S.valid, S.order]);
  await source.query(`INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,session_id,created_at,device_info)
    VALUES($1,$2,'歷史名稱','歷史員工號','login','local-source-session','2021-01-01T01:02:03.123456Z','null'::jsonb)`, [S.login, S.one]);
  await source.query(`INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,last_heartbeat_at)
    VALUES($1,$2,'2021-01-01T01:02:03.123456Z',NULL,NULL,'2021-01-01T01:03:04.654321Z')`, [S.work, S.one]);
  await source.query(`INSERT INTO private.employee_work_stop_markers(user_id,stopped_at) VALUES($1,'2021-01-01T01:03:04.654321Z')`, [S.one]);
  await source.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,audited_by,audited_at)
    VALUES($1,$2,'完全虛構姓名','完全虛構證號','無真實電話','無真實地址','approved',$3,'2021-01-01T01:02:03.123456Z')`, [S.verification, S.one, S.branch]);
  await transaction(seedNotifications, source, true);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    SELECT $1,'mapped-notifications-other-root',password_hash,'super_admin',true FROM public.admins WHERE id=$2`, [S.otherRoot, NEW.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [S.otherRoot]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  other = await adminLogin(db, 'mapped-notifications-other-root', PASSWORDS.root); pkg = randomUUID();
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await transaction(async () => {
    shared = await capture('shared'); dispatch = await capture('dispatch'); identity = await capture('identity');
    finance = await capture('finance'); activity = await capture('activity'); verification = await capture('verification'); notifications = await capture('notifications');
  }, source, true);
  assert.deepEqual(notifications.catalog.identity_catalog, identity.catalog);
  assert.deepEqual(notifications.catalog.finance_catalog, finance.catalog);
  console.log('SQL54 setup: source exports and two independent encrypted disk backups');
  await transaction(async () => {
    const prepared = await prepare('shared', shared); sharedTask = prepared.job;
    const result = await rpc('employee_import_shared_replace_apply', { ...auth(sharedTask), p_plan_hash: prepared.plan.plan_hash });
    assert.equal(result.success, true); assert.equal(result.admin_map[S.branch], NEW.branch);
    await rpc('employee_transfer_cancel', auth(sharedTask));
  }, db, true);
  await transaction(async () => {
    const prepared = await prepare('dispatch', dispatch); task = prepared.job;
    await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: prepared.plan.plan_hash,
      p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
    const p = await rpc('get_employee_import_dispatch_configuration_plan', auth());
    assert.equal((await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: p.plan_hash })).configuration_applied, true);
    const started = await rpc('employee_import_dispatch_valid_begin', { ...auth(), p_plan_hash: p.plan_hash });
    for (let no = 0; no < started.chunks; no++) await rpc('employee_import_dispatch_valid_chunk', { ...auth(), p_chunk_no: no });
    assert.equal((await rpc('employee_import_dispatch_valid_verify', auth())).verified, true);
    await restoreIdentities(); await restoreDependencies();
  }, db, true);
  console.log('SQL54 setup: SQL48–50 verified; restoring actual funds/activity');
  await transaction(() => restoreMapped('finance'), db, true);
  await transaction(() => restoreMapped('activity'), db, true);
  preVerificationDump = await db.dumpDataDir('none');
  await transaction(() => restoreMapped('verification'), db, true);
  await transaction(noLegacy);
  readyDump = await db.dumpDataDir('none');
  console.log('SQL54 setup: real SQL53 verified (one request, zero files)');
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });

function chunkReceipt(key, no, text) {
  return { table_key: key, chunk_no: no, rows: lines(text).length, bytes: Buffer.byteLength(text), sha256: sha(text) };
}
function receipt(key, no, text) {
  return { success: true, scope: SCOPE, ...chunkReceipt(key, no, text), full_site_complete: false };
}
function checkCommon(p, input = notifications) {
  assert.equal(p.scope, SCOPE); assert.equal(p.job_id, task.job_id);
  assert.equal(p.package_id, pkg); assert.equal(p.source_site_id, input.catalog.site_id); assert.notEqual(p.site_id, p.source_site_id);
  for (const key of ['job_id', 'site_id', 'source_site_id', 'package_id']) assert.match(p[key], /^[0-9a-f-]{36}$/);
  assert.match(p.mapping_hash, /^[0-9a-f]{64}$/);
  for (const key of GATES) assert.equal(p[key], false, key);
  if (Object.hasOwn(p, 'replacement_ready')) assert.equal(p.replacement_ready, false);
  for (const key of PENDING) assert.equal(p[key], true, key);
  for (const key of ['maintenance', 'dependencies_pending', 'financial_data_pending']) assert.equal(p[key], true, key);
}
function checkPlan(p, input = notifications) {
  assert.deepEqual(Object.keys(p).sort(), [...COMMON_KEYS, 'catalog_hash', 'plan_hash', 'checked', 'counts', 'employees', 'rewards', 'conflicts'].sort());
  checkCommon(p, input); assert.equal(p.checked, true);
  for (const key of ['catalog_hash', 'plan_hash']) assert.match(p[key], /^[0-9a-f]{64}$/);
  assert.deepEqual(p.counts, Object.fromEntries(input.catalog.tables.map(t => [t.key, t.rows])));
  assert.equal(p.employees, EMPLOYEES.length); assert.equal(p.rewards, 2);
  assert.ok(Array.isArray(p.conflicts)); assert.equal(new Set(p.conflicts).size, p.conflicts.length);
  assert.deepEqual(p.conflicts, p.conflicts.slice().sort(byteOrder), 'Conflict codes must have deterministic C ordering.');
  for (const reason of p.conflicts) assert.ok(CONFLICTS.includes(reason), reason);
  assert.doesNotMatch(JSON.stringify(p), /password|session_token|job_token|identity_map|admin_map|原內容|private diagnostic/);
}
function checkStatus(s, input = notifications, { bound = true, complete = true } = {}) {
  assert.deepEqual(Object.keys(s).sort(), [...COMMON_KEYS, 'bound', 'catalog_hash', 'catalog', 'tables', 'complete', 'plan', 'chunk'].sort());
  checkCommon(s, input); assert.equal(s.bound, bound); assert.equal(s.complete, complete);
  assert.deepEqual(s.catalog, bound ? input.catalog : null);
  if (bound) assert.match(s.catalog_hash, /^[0-9a-f]{64}$/); else assert.equal(s.catalog_hash, null);
  assert.ok(Array.isArray(s.tables)); assert.deepEqual(s.tables.map(t => t.key), KEYS);
  for (const t of s.tables) {
    assert.deepEqual(Object.keys(t).sort(), ['key', 'chunks', 'rows', 'bytes', 'row_hashes_sha256'].sort());
    for (const key of ['chunks', 'rows', 'bytes']) assert.ok(Number.isSafeInteger(t[key]) && t[key] >= 0, `${t.key}:${key}`);
    assert.match(t.row_hashes_sha256, /^[0-9a-f]{64}$/);
    if (!bound) assert.deepEqual(t, { key: t.key, chunks: 0, rows: 0, bytes: 0, row_hashes_sha256: sha('') });
    if (complete) {
      const wanted = input.catalog.tables.find(c => c.key === t.key);
      for (const field of ['rows', 'bytes', 'row_hashes_sha256']) assert.deepEqual(t[field], wanted[field]);
      assert.ok(t.chunks >= 1);
    }
  }
  if (complete) { checkPlan(s.plan, input); assert.equal(s.catalog_hash, s.plan.catalog_hash); }
  else assert.equal(s.plan, null);
  assert.ok(Object.hasOwn(s, 'chunk'));
  return s;
}
async function stage(input = notifications, { role = 'anon', omit = null, size = 200 } = {}) {
  const b = await bind(input, {}, role);
  assert.deepEqual(Object.keys(b).sort(), ['success', 'scope', 'catalog_hash', 'full_site_complete'].sort());
  assert.equal(b.success, true); assert.equal(b.scope, SCOPE); assert.equal(b.full_site_complete, false);
  for (const key of KEYS) for (const [no, text] of chunks(input.texts[key], size).entries()) {
    if (`${key}:${no}` === omit) continue;
    assert.deepEqual(await stageChunk(key, no, text, {}, role), receipt(key, no, text));
  }
  return b;
}
// Negative caller-controlled wire inputs only. Retain untouched raw lines (especially numeric literals).
function altered(changes) {
  const texts = { ...notifications.texts };
  for (const [key, transform] of Object.entries(changes)) texts[key] = lines(transform(texts[key]))
    .sort((a, b) => byteOrder(JSON.parse(a).id, JSON.parse(b).id)).join('');
  return { texts, catalog: { ...notifications.catalog, tables: KEYS.map(key => ({ key, rows: lines(texts[key]).length,
    bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: sha(lines(texts[key]).map(sha).join('')) })) } };
}
const patchRow = (match, patch) => text => lines(text).map(line => {
  const r = JSON.parse(line);
  if (!match(r)) return line;
  // Patch only named JSON fields by their exact serialized token. Other numeric tokens stay byte-exact.
  let output = line;
  for (const [key, value] of Object.entries(patch)) {
    const oldToken = JSON.stringify(r[key]);
    if (typeof r[key] === 'number') assert.ok(Number.isSafeInteger(r[key]), `Do not round source numeric field ${key}`);
    const pattern = new RegExp(`("${key}"\\s*:\\s*)${oldToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    assert.match(output, pattern); output = output.replace(pattern, (_all, prefix) => prefix + JSON.stringify(value));
  }
  return output;
}).join('');

// 1–4: structural contract and genuinely read-only, non-restoring happy paths.
test('strict replay remains 581 files, twelve known failures, 109 tables/967 columns', () => transaction(async () => {
  assert.equal(replay.files.length, 581); assert.equal(replay.files.at(-1), MIGRATION);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') AND NOT c.relispartition`), 109);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') AND NOT c.relispartition AND a.attnum>0 AND NOT a.attisdropped`), 967);
}));
test('four exact signatures, no defaults; STABLE plan/status and all private helpers revoked', () => transaction(async () => {
  const specs = { bind: [['p_catalog'], ['jsonb']], stage: [['p_table_key', 'p_chunk_no', 'p_ndjson'], ['text', 'integer', 'text']],
    plan: [[], []], status: [['p_table_key', 'p_chunk_no'], ['text', 'integer']] };
  const fns = await rows(db, `SELECT proname,provolatile,prosecdef,proconfig,proargnames,pronargdefaults,oid::regprocedure::text AS signature,
    (SELECT array_agg(format_type(t,NULL) ORDER BY n) FROM unnest(proargtypes::oid[]) WITH ORDINALITY a(t,n)) AS types,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'employee_import_mapped_notifications_%' ORDER BY proname`);
  assert.deepEqual(fns.map(f => f.proname), OPERATIONS.map(op => PREFIX + op).sort());
  for (const fn of fns) {
    const op = fn.proname.slice(PREFIX.length);
    assert.deepEqual(fn.proargnames, ['p_admin_session_token', 'p_job_token', ...specs[op][0]]);
    assert.deepEqual(fn.types, ['uuid', 'uuid', ...specs[op][1]]); assert.equal(fn.pronargdefaults, 0);
    assert.equal(fn.prosecdef, true); assert.equal(fn.provolatile, ['plan', 'status'].includes(op) ? 's' : 'v');
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp')); assert.equal(fn.public_execute, false);
    for (const role of ['anon', 'authenticated', 'service_role'])
      assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), role !== 'service_role');
    await assert.rejects(call(op, argsFor(op), 'service_role'), /permission denied/);
  }
  const helpers = await rows(db, `SELECT prosecdef,proconfig,oid::regprocedure::text AS signature,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_mapped_notifications_%'`);
  assert.equal(helpers.length, 10);
  for (const fn of helpers) {
    assert.equal(fn.prosecdef, true); assert.equal(fn.public_execute, false);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), false);
  }
  await assert.rejects(call('status'), { code: '42883' });
  for (const role of ['anon', 'authenticated', 'service_role']) await isolated(async () => {
    await db.exec(`SET LOCAL ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM private.employee_transfer_staging LIMIT 1'), /permission denied/);
  });
}));
for (const role of ['anon', 'authenticated']) test(`${role}: all thirteen raw tables checked; only dedicated private staging changes`, () => transaction(async () => {
  const before = await snapshot(), modes = await triggers(), sourceBefore = await snapshot(source), oldSummary = await summary();
  const b = await stage(notifications, { role });
  const p = await plan({}, role); checkPlan(p); assert.deepEqual(p.conflicts, []); assert.equal(p.catalog_hash, b.catalog_hash);
  const s = checkStatus(await status(null, null, {}, role)); assert.equal(s.chunk, null); assert.deepEqual(s.plan, p);
  for (const key of KEYS) {
    assert.ok(notifications.catalog.tables.find(t => t.key === key).rows >= 1);
    const stored = await scalar(db, 'SELECT payload->>\'ndjson\' FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key=$2 AND chunk_no=0', [task.job_id, INPUT + key]);
    assert.equal(stored, notifications.texts[key], key);
    const part = await status(key, 0, {}, role); assert.deepEqual(part.chunk, chunkReceipt(key, 0, stored));
    assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key}`), 0, key);
  }
  const changed = (await snapshot()).filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i])).map(r => r.name);
  assert.deepEqual(changed, ['private.employee_transfer_staging']);
  const namespaces = await rows(db, `SELECT employee_id,table_key,chunk_no,row_count FROM private.employee_transfer_staging
    WHERE job_id=$1 AND table_key LIKE 'mapped-notifications%' ORDER BY table_key`, [task.job_id]);
  assert.equal(namespaces.length, 14);
  for (const r of namespaces) { assert.equal(r.employee_id, ZERO); assert.equal(r.chunk_no, 0); assert.ok(r.table_key === CATALOG || KEYS.some(k => r.table_key === INPUT + k)); }
  assert.deepEqual(await summary(), oldSummary); assert.deepEqual(await triggers(), modes); assert.deepEqual(await snapshot(source), sourceBefore); await noLegacy();
}));

test('source export independently preserves every column, virtual keys, precision, NULL and microseconds', () => transaction(async () => {
  for (const key of KEYS) {
    let projection = 'to_jsonb(r)';
    if (key === 'notification_automation_plan_members') projection += "||jsonb_build_object('id',r.user_id::text)";
    if (['notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_failures'].includes(key))
      projection += "||jsonb_build_object('id',r.task_id::text||':'||r.user_id::text)";
    if (key === 'notification_automation_date_runs') projection += "||jsonb_build_object('id',r.task_id::text||':'||lpad(r.task_version::text,10,'0')||':'||r.period_key)";
    if (key === 'notification_automation_progress') projection += "||jsonb_build_object('last_stage',r.last_stage::text)";
    if (key === 'notification_automation_executions') projection += "||jsonb_build_object('stage',r.stage::text,'error_message',CASE WHEN r.error_message IS NULL THEN NULL ELSE 'redacted migration error' END)";
    if (key === 'notification_automation_failures') projection += "||jsonb_build_object('last_error','redacted migration error')";
    if (key === 'message_recipients') projection = "(to_jsonb(r)-ARRAY['delivery_claim_token','delivery_claim_channel','delivery_claim_until','delivery_completed_claim_token'])||jsonb_build_object('delivery_sequence',r.delivery_sequence::text)";
    const original = await rows(source, `SELECT (${projection})::text||E'\n' AS body FROM public.${key} r`);
    const wanted = original.map(r => r.body).sort((a, b) => byteOrder(JSON.parse(a).id, JSON.parse(b).id)).join('');
    assert.equal(notifications.texts[key], wanted, key);
    const table = notifications.catalog.tables.find(t => t.key === key);
    assert.equal(table.bytes, Buffer.byteLength(wanted)); assert.equal(table.row_hashes_sha256, sha(lines(wanted).map(sha).join('')));
  }
  assert.ok(notifications.texts.messages.includes(MANUAL_REWARD)); assert.ok(notifications.texts.notification_automation_progress.includes(PRECISE));
  assert.ok(notifications.texts.message_recipients.includes(`"${BIG}"`)); assert.ok(notifications.texts.messages.includes('123456'));
  assert.doesNotMatch(JSON.stringify(notifications.texts), /delivery_claim|private diagnostic/);
  const historical = lines(notifications.texts.notification_automation_executions).map(JSON.parse).find(r => r.id === N.historical);
  assert.equal(historical.status, 'failed');
  for (const key of ['task_id', 'owner_admin_id', 'user_id', 'plan_id', 'message_id', 'wallet_transaction_id', 'completed_at', 'error_message']) assert.equal(historical[key], null);
  // Keep this real exported all-NULL historical execution as the positive counterpart to #70–72.
  await stage(); const p = await plan(); checkPlan(p); assert.deepEqual(p.conflicts, []);
  await db.exec("SET LOCAL TimeZone='America/New_York'");
  assert.deepEqual(await plan(), p); checkStatus(await status()); assert.equal(await scalar(db, "SELECT current_setting('TimeZone')"), 'America/New_York');
}));
test('manual and circular automation rewards use existing mapped transactions/reference/operation; no second credit', () => transaction(async () => {
  const target = bindings[S.one].target_id;
  const bonuses = await rows(db, "SELECT id,user_id,amount::text,reference_id,operation_id FROM public.wallet_transactions WHERE type='performance_bonus' ORDER BY reference_id");
  assert.equal(bonuses.length, 2);
  for (const r of bonuses) assert.equal(r.user_id, target);
  const manual = bonuses.find(r => r.reference_id === N.manualRecipient), automatic = bonuses.find(r => r.reference_id === N.autoRecipient);
  assert.equal(manual.amount, MANUAL_REWARD); assert.equal(manual.operation_id, N.manualOperation);
  assert.equal(automatic.amount, AUTO_REWARD); assert.equal(automatic.operation_id, N.execution);
  const execution = lines(notifications.texts.notification_automation_executions).map(JSON.parse).find(r => r.id === N.execution);
  const message = lines(notifications.texts.messages).map(JSON.parse).find(r => r.id === N.automatic);
  assert.equal(execution.wallet_transaction_id, automatic.id); assert.equal(execution.message_id, message.id); assert.equal(message.automation_execution_id, execution.id);
  assert.notEqual(target, S.one); await stage(); await unchanged(async () => { const p = await plan(); checkPlan(p); assert.deepEqual(p.conflicts, []); checkStatus(await status()); });
  await noLegacy();
}));
test('real READ ONLY plan/status before bind, during partial staging and after completion have no side effects', () => withClone(readyDump, async () => {
  for (const phase of ['unbound', 'partial', 'complete']) {
    if (phase === 'partial') await transaction(async () => { await bind(); await stageChunk('messages', 0, notifications.texts.messages); }, db, true);
    if (phase === 'complete') await transaction(() => stage(), db, true);
    await transaction(async () => {
      await db.exec('SET TRANSACTION READ ONLY');
      await unchanged(async () => {
        const s = checkStatus(await status(), notifications, { bound: phase !== 'unbound', complete: phase === 'complete' });
        if (phase === 'complete') assert.deepEqual(await plan(), s.plan); else await assert.rejects(plan());
        if (phase === 'partial') assert.deepEqual((await status('messages', 0)).chunk, chunkReceipt('messages', 0, notifications.texts.messages));
      });
    });
  }
}));
test('unbound/partial status distinguishes missing chunks; key/no must both be NULL or both specified', () => transaction(async () => {
  checkStatus(await status(), notifications, { bound: false, complete: false });
  await bind(); checkStatus(await status(), notifications, { complete: false });
  await stageChunk('messages', 0, notifications.texts.messages);
  const s = checkStatus(await status('messages', 0), notifications, { complete: false }); assert.deepEqual(s.chunk, chunkReceipt('messages', 0, notifications.texts.messages));
  assert.equal((await status('messages', 1)).chunk, null); assert.equal((await status('broadcast_messages', 0)).chunk, null);
  for (const [key, no] of [['messages', null], [null, 0], ['orders', 0], ['public.messages', 0], ['messages', -1], ['messages', 500001]])
    await unchanged(() => assert.rejects(status(key, no)));
}));
test('only large fixture: 205 real date rows export/stage at 200/5, exact ordered hashes and status', () => transaction(async () => {
  const large = await transaction(async () => {
    await source.query(`INSERT INTO public.notification_automation_date_runs(task_id,task_version,period_key,created_at)
      SELECT $1,7,'year-'||lpad(n::text,4,'0'),'2024-02-29T01:02:03.654321Z' FROM generate_series(2,205) x(n)`, [N.annual]);
    return capture('notifications');
  }, source);
  assert.deepEqual(large.catalog.finance_catalog, finance.catalog);
  assert.deepEqual(large.pages.notification_automation_date_runs, [200, 5]);
  const key = 'notification_automation_date_runs', parts = chunks(large.texts[key]); assert.deepEqual(parts.map(p => lines(p).length), [200, 5]);
  await bind(large);
  await unchanged(() => assert.rejects(stageChunk(key, 0, lines(large.texts[key]).slice(0, 201).join(''))));
  await stage(large, { omit: `${key}:1` }); assert.equal((await status()).complete, false); await assert.rejects(plan());
  await stageChunk(key, 1, parts[1]); const p = await plan(); checkPlan(p, large); assert.deepEqual(p.conflicts, []);
  const s = checkStatus(await status(key, 1), large); assert.equal(s.tables.find(t => t.key === key).chunks, 2); assert.deepEqual(s.chunk, chunkReceipt(key, 1, parts[1]));
}));
test('catalog immutable; repeated bind and byte-identical chunks return original receipts without writes', () => transaction(async () => {
  const b = await stage(), p = await plan();
  await unchanged(async () => {
    assert.deepEqual(await bind(), b);
    for (const key of KEYS) assert.deepEqual(await stageChunk(key, 0, notifications.texts[key]), receipt(key, 0, notifications.texts[key]));
    assert.deepEqual(await plan(), p);
    await assert.rejects(bind(altered({ messages: text => text.replace('普通原文', '變更原文') })));
    await assert.rejects(stageChunk('messages', 0, notifications.texts.messages.replace('普通原文', '變更原文')));
  });
}));
test('catalog validates same source/package/identity/finance and fixed thirteen-table schema, never caller mappings', () => transaction(async () => {
  for (const patch of [{ site_id: randomUUID() }, { package_id: randomUUID() }, { identity_map: {} }, { full_site_complete: true },
    { tables: notifications.catalog.tables.slice().reverse() }, { tables: notifications.catalog.tables.slice(1) },
    { identity_catalog: { ...identity.catalog, tables: identity.catalog.tables.map(t => ({ ...t, row_hashes_sha256: sha('wrong identity') })) } },
    { finance_catalog: { ...finance.catalog, tables: finance.catalog.tables.map(t => ({ ...t, row_hashes_sha256: sha('wrong finance') })) } }])
    await unchanged(() => assert.rejects(bind({ catalog: { ...notifications.catalog, ...patch } })));
}));
test('contiguous chunks, strict C order across blocks and exact directory totals; no missing-block success', () => transaction(async () => {
  await bind(); const raw = lines(notifications.texts.messages);
  for (const no of [null, -1, 1, 500001]) await unchanged(() => assert.rejects(stageChunk('messages', no, raw[0])));
  await unchanged(() => assert.rejects(stageChunk('messages', 0, raw.slice().reverse().join(''))));
  await stageChunk('messages', 0, raw[0]); await unchanged(() => assert.rejects(stageChunk('messages', 1, raw[0])));
  await stageChunk('messages', 1, raw[1]); assert.equal((await status()).complete, false);
  await stageChunk('messages', 2, raw[2]);
  for (const key of KEYS.filter(k => k !== 'messages')) await stageChunk(key, 0, notifications.texts[key]);
  checkStatus(await status()); assert.deepEqual((await plan()).conflicts, []);
  await unchanged(() => assert.rejects(stageChunk('messages', 3, raw[2])));
}));
test('every empty table needs chunk zero, cannot skip/repeat as a new block; unsupported source date flag stays explicit', () => transaction(async () => {
  const key = 'notification_automation_date_runs', input = altered({ [key]: () => '' }); input.catalog.date_runs_supported = false;
  await stage(input, { omit: `${key}:0` }); assert.equal((await status()).complete, false); await assert.rejects(plan());
  const r = await stageChunk(key, 0, ''); assert.deepEqual(r, receipt(key, 0, ''));
  await unchanged(async () => { assert.deepEqual(await stageChunk(key, 0, ''), r); await assert.rejects(stageChunk(key, 1, '')); });
  const p = await plan(); checkPlan(p, input); assert.deepEqual(p.conflicts, []); checkStatus(await status(), input);
}));
test('mixed ASCII case/punctuation composite date IDs follow C bytes, not locale order', () => transaction(async () => {
  const key = 'notification_automation_date_runs', row = JSON.parse(lines(notifications.texts[key])[0]);
  const input = altered({ [key]: () => ['a:1', '_', 'Z'].map(period_key => JSON.stringify({ ...row, period_key, id: `${N.annual}:0000000007:${period_key}` }) + '\n').join('') });
  assert.deepEqual(lines(input.texts[key]).map(l => JSON.parse(l).period_key), ['Z', '_', 'a:1']);
  await stage(input, { size: 1 }); checkStatus(await status(), input); const p = await plan(); checkPlan(p, input); assert.deepEqual(p.conflicts, []);
}));
test('reject malformed/duplicate/escaped JSON keys, leases, unsupported tables and unterminated lines atomically', () => transaction(async () => {
  await bind(); const raw = lines(notifications.texts.message_recipients)[0];
  for (const text of [raw.slice(0, -1), raw.replace('{', '{"unexpected":1,'), raw.replace('{', '{"id":"' + N.manualRecipient + '",'),
    raw.replace('{', '{"\\u0069d":"' + N.manualRecipient + '",'), ...['delivery_claim_token', 'delivery_claim_channel', 'delivery_claim_until', 'delivery_completed_claim_token'].map(k => raw.replace('{', `{"${k}":null,`)), raw + raw])
    await unchanged(() => assert.rejects(stageChunk('message_recipients', 0, text)));
  for (const key of [null, 'orders', 'notification_automation_queue', 'public.messages', 'mapped-notifications-in:messages'])
    await unchanged(() => assert.rejects(stageChunk(key, 0, '')));
}));
test('reject >64KiB rows, >256KiB chunks, NULL input and invalid bigint/composite/timestamps or snapshots', () => transaction(async () => {
  await bind(); const message = JSON.parse(lines(notifications.texts.messages)[0]), recipient = lines(notifications.texts.message_recipients)[0];
  for (const text of [null, JSON.stringify({ ...message, title: 'x'.repeat(65536) }) + '\n', 'x'.repeat(262145)])
    await unchanged(() => assert.rejects(stageChunk('messages', 0, text)));
  for (const text of [recipient.replace(`"${BIG}"`, BIG), recipient.replace(BIG, '9223372036854775808')]) {
    assert.notEqual(text, recipient, 'The negative bigint fixture must actually change the source line.');
    await unchanged(() => assert.rejects(stageChunk('message_recipients', 0, text)));
  }
  const badTime = altered({ message_recipients: patchRow(r => r.id === N.manualRecipient, { read_at: 'infinity' }) });
  await unchanged(() => assert.rejects(stageChunk('message_recipients', 0, badTime.texts.message_recipients)));
  const progress = notifications.texts.notification_automation_progress.replace(`${N.task}:${S.one}`, S.one);
  await unchanged(() => assert.rejects(stageChunk('notification_automation_progress', 0, progress)));
  const execution = lines(notifications.texts.notification_automation_executions)[0].replace('"trigger_type":', '"unknown":true,"trigger_type":');
  await unchanged(() => assert.rejects(stageChunk('notification_automation_executions', 0, execution)));
  await unchanged(() => assert.rejects(stageChunk('notification_automation_failures', 0, notifications.texts.notification_automation_failures.replace('redacted migration error', RAW_ERROR))));
}));

// Source issues are adversarial raw catalogs, not fabricated server receipts or successful backups.
for (const [label, changes, conflict] of [
  ['unmapped employee', { broadcast_recipients: patchRow(() => true, { employee_id: S.unrelated }) }, 'source_employee_missing'],
  ['unmapped administrator', { message_templates: patchRow(() => true, { admin_id: S.unrelated }) }, 'source_admin_unmapped'],
  ['missing parent', { notification_automation_tasks: patchRow(r => r.id === N.task, { source_task_id: S.unrelated }) }, 'source_reference_missing'],
  ['cross-owner task/plan', { notification_automation_tasks: patchRow(r => r.id === N.task, { plan_id: N.emptyPlan }) }, 'source_scope_mismatch'],
  ['cross-owner member', { notification_automation_plan_members: patchRow(() => true, { user_id: S.two, id: S.two }) }, 'source_scope_mismatch'],
  ['duplicate recipient pair under distinct IDs', { message_recipients: text => text + patchRow(() => true, { id: id(999) })(lines(text)[0]) }, 'source_unique_collision'],
  ['case-folded plan name', { notification_automation_plans: text => text + patchRow(r => r.id === N.plan, { id: id(998), name: '來源方案 ALPHA' })(lines(text)[0]) }, 'source_unique_collision'],
  ['precise manual reward amount changed', { messages: text => text.replace(MANUAL_REWARD, '12.12345678901234567890123456788') }, 'reward_link_mismatch'],
  ['reward recipient reference changed', { message_recipients: patchRow(r => r.id === N.autoRecipient, { id: id(997) }) }, 'reward_link_mismatch'],
  ['reward user changed', { message_recipients: patchRow(r => r.id === N.autoRecipient, { recipient_id: S.two }), notification_automation_executions: patchRow(r => r.id === N.execution, { user_id: S.two }) }, 'reward_link_mismatch'],
  ['reward operation changed', { messages: patchRow(r => r.id === N.automatic, { automation_execution_id: id(996) }), notification_automation_executions: patchRow(r => r.id === N.execution, { id: id(996) }) }, 'reward_link_mismatch'],
  ['succeeded wallet transaction missing', { notification_automation_executions: patchRow(r => r.id === N.execution, { wallet_transaction_id: null }) }, 'reward_link_mismatch'],
  ['circular execution/message broken', { notification_automation_executions: patchRow(r => r.id === N.execution, { message_id: null }) }, 'reward_link_mismatch'],
  ['reward currency mismatch', { messages: patchRow(r => r.id === N.automatic, { reward_currency: 'USD' }) }, 'reward_link_mismatch'],
  ['unfinished execution', { notification_automation_executions: patchRow(r => r.id === N.historical, { status: 'processing' }) }, 'unfinished_execution'],
]) test(`plan reports ${label} without restoring or paying`, () => transaction(async () => {
  const input = altered(changes); await stage(input);
  await unchanged(async () => {
    const p = await plan(); checkPlan(p, input); assert.ok(p.conflicts.includes(conflict), JSON.stringify(p.conflicts));
    assert.deepEqual((await status()).plan, p); assert.deepEqual(await plan(), p);
  });
  await noLegacy();
}));
test('identical composite IDs cannot hide duplicate rows even with a matching caller catalog', () => transaction(async () => {
  const key = 'notification_automation_task_recipients', input = altered({ [key]: text => text + text });
  await bind(input); await unchanged(() => assert.rejects(stageChunk(key, 0, input.texts[key])));
}));

for (const [label, extra] of [
  ['NULL/random/source session', () => [null, randomUUID(), sourceSession].map(p_admin_session_token => ({ p_admin_session_token }))],
  ['secondary/emergency/foreign super-admin', () => [branch, emergency, other].map(p_admin_session_token => ({ p_admin_session_token }))],
  ['NULL/random/ended shared token', () => [null, randomUUID(), sharedTask.job_token].map(p_job_token => ({ p_job_token }))],
]) test(`all four entry points reject ${label}`, () => transaction(async () => {
  await stage(); for (const input of extra()) await denyAll(input);
}));
test('expired/revoked sessions, expired/stale/cancelled/protocol-mismatched jobs and missing seal/maintenance fail closed', () => transaction(async () => {
  await stage();
  for (const [sql, params] of [
    ["UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", [session]],
    ['UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)', [session]],
    ["UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [task.job_id]],
    ["UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [task.job_id]],
    ["UPDATE private.employee_transfer_jobs SET status='cancelled' WHERE id=$1", [task.job_id]],
    ["UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,'{import_protocol}','\"shared-import-v1\"') WHERE id=$1", [task.job_id]],
    ['UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', [task.job_id]],
    ['DELETE FROM private.employee_transfer_maintenance WHERE job_id=$1', [task.job_id]],
  ]) await isolated(async () => { const changed = await rows(db, sql + ' RETURNING 1', params); assert.ok(changed.length > 0); await denyAll(); });
}));
for (const missing of ['not begun', 'one employee only', 'all applied but not verified'])
  test(`SQL53 verified is mandatory: ${missing}`, () => withClone(preVerificationDump, () => transaction(async () => {
    if (missing !== 'not begun') await restoreMapped('verification', { applied: missing === 'one employee only' ? [S.one] : EMPLOYEES, verify: false });
    await denyAll(); await noLegacy();
  })));
for (const [label, relation, sql, params] of [
  ['identity', 'public.users', "UPDATE public.users SET remarks='same-count drift' WHERE id=$1", () => [bindings[S.one].target_id]],
  ['order', 'public.orders', "UPDATE public.orders SET created_at=created_at+interval '1 microsecond' WHERE id=$1", () => [S.order]],
  ['membership', 'public.dispatch_group_members', "UPDATE public.dispatch_group_members SET assigned_at=assigned_at+interval '1 microsecond' WHERE user_id=$1", () => [bindings[S.one].target_id]],
  ['finance', 'public.wallets', 'UPDATE public.wallets SET available_balance=available_balance+0.00000000000000000000000000001 WHERE user_id=$1', () => [bindings[S.one].target_id]],
  ['login', 'public.employee_login_history', "UPDATE public.employee_login_history SET device_info='{}'::jsonb WHERE id=$1", () => [S.login]],
  ['work', 'public.work_sessions', "UPDATE public.work_sessions SET last_heartbeat_at=last_heartbeat_at+interval '1 microsecond' WHERE id=$1", () => [S.work]],
  ['verification', 'public.verification_requests', "UPDATE public.verification_requests SET audit_remark='same-count drift' WHERE id=$1", () => [S.verification]],
]) test(`every entry physically rechecks verified ${label}, not just cached flags`, () => transaction(async () => {
  await stage(); const changed = await change(relation, sql + ' RETURNING 1', params()); assert.equal(changed.length, 1); await denyAll();
}));
test('SQL48–53 saved mapping/verified/count corruption is rejected, never promoted into old verified maps', () => transaction(async () => {
  await stage();
  for (const [key, employee, path, value] of [
    ['identity-reservation-v1', S.one, ['target_id'], S.two], ['mapped-identity-v1', S.one, ['verified'], false],
    ['mapped-dependencies-v1', ZERO, ['identity_map'], {}], ['mapped-finance-v1', ZERO, ['verified'], false],
    ['mapped-activity-v1', ZERO, ['verified'], false], ['mapped-verification-v1', ZERO, ['verified'], false],
    ['mapped-verification-done-v1', S.one, ['counts', 'verification_requests'], 0],
  ]) await isolated(async () => {
    const changed = await rows(db, 'UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$4::text[],$5::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key=$3 RETURNING 1',
      [task.job_id, employee, key, path, JSON.stringify(value)]); assert.equal(changed.length, 1); await denyAll();
  });
}));
test('legacy notification summaries/staging cannot be mixed with mapped namespace', () => transaction(async () => {
  await stage();
  for (const key of ['notifications_catalog', 'notifications_plan', 'notification_restore', 'notification_media_files', 'notification_storage_origin'])
    await isolated(async () => {
      await db.query('UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,$2::text[],$3::jsonb) WHERE id=$1', [task.job_id, [key], JSON.stringify(key === 'notifications_catalog' ? notifications.catalog : {})]);
      await denyAll();
    });
  for (const legacy of ['notifications-in:messages', 'notifications-done', 'notifications-media-import']) await isolated(async () => {
    // Move an actual SQL54 chunk into the forbidden old namespace; do not invent positive state.
    const changed = await rows(db, 'UPDATE private.employee_transfer_staging SET table_key=$2 WHERE job_id=$1 AND table_key=$3 RETURNING 1', [task.job_id, legacy, INPUT + 'messages']);
    assert.equal(changed.length, 1); await denyAll();
  });
}));
test('raw bytes and parsed rows cannot diverge behind self-consistent metadata, count and hashes', () => transaction(async () => {
  await stage();
  for (const expression of [
    "jsonb_set(payload,'{rows,0,title}','\"forged parsed title\"')",
    "jsonb_set(payload,'{ndjson}',to_jsonb(replace(payload->>'ndjson','普通原文','變更原文')))",
    // Make bytes AND raw hash string AND last_id match the tampered raw; parsed rows still differ.
    "jsonb_set(jsonb_set(jsonb_set(payload,'{ndjson}',to_jsonb(replace(payload->>'ndjson','普通原文','變更原文'))),'{bytes}',to_jsonb(octet_length(replace(payload->>'ndjson','普通原文','變更原文')))),'{row_hashes}',(SELECT to_jsonb(string_agg(encode(extensions.digest(convert_to(line||E'\\n','UTF8'),'sha256'),'hex'),'' ORDER BY n)) FROM unnest(string_to_array(rtrim(replace(payload->>'ndjson','普通原文','變更原文'),E'\\n'),E'\\n')) WITH ORDINALITY x(line,n)))",
  ]) await isolated(async () => {
    const changed = await rows(db, `UPDATE private.employee_transfer_staging SET payload=${expression} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0 RETURNING 1`, [task.job_id, INPUT + 'messages']);
    assert.equal(changed.length, 1); await denyAll();
  });
}));
test('staging bytes/hash/last ID/catalog and namespace corruption never accepts matching counts alone', () => transaction(async () => {
  await stage();
  for (const [key, assignment] of [
    [INPUT + 'messages', "payload=jsonb_set(payload,'{bytes}',to_jsonb((payload->>'bytes')::int+1))"],
    [INPUT + 'messages', "payload=jsonb_set(payload,'{row_hashes}',to_jsonb(repeat('0',length(payload->>'row_hashes'))))"],
    [INPUT + 'messages', "payload=jsonb_set(payload,'{last_id}','null'::jsonb)"],
    [INPUT + 'messages', 'row_count=row_count+1'], [INPUT + 'messages', 'chunk_no=999'],
    [INPUT + 'messages', `employee_id='${S.unrelated}'`], [INPUT + 'messages', "table_key='mapped-notifications-in:orders'"],
    [CATALOG, "payload=jsonb_set(payload,'{package_id}',to_jsonb('" + S.unrelated + "'::text))"], [CATALOG, 'row_count=2'],
  ]) await isolated(async () => {
    const changed = await rows(db, `UPDATE private.employee_transfer_staging SET ${assignment} WHERE job_id=$1 AND table_key=$2 RETURNING 1`, [task.job_id, key]);
    assert.equal(changed.length, 1); await denyAll();
  });
}));

test('mapped target employee notification residue is a conflict, never a delete/merge/write permission', () => transaction(async () => {
  await stage();
  await change('public.messages', `INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,audit_origin,delivery_mode)
    VALUES($1,$2,'root','local residue','local residue','realtime','normal','manual_admin','realtime_only')`, [id(200), NEW.root]);
  await change('public.message_recipients', 'INSERT INTO public.message_recipients(message_id,recipient_id) VALUES($1,$2)', [id(200), bindings[S.two].target_id]);
  await unchanged(async () => { const p = await plan(); checkPlan(p); assert.ok(p.conflicts.includes('notification_target_not_empty'), JSON.stringify(p.conflicts)); assert.deepEqual((await status()).plan, p); });
  // This is a raw preparation phase, not an apply: a conflict may coexist with immutable staging.
  // Repeating known bytes must neither erase the conflict nor grant any business write permission.
  await unchanged(async () => {
    assert.equal((await bind()).success, true);
    assert.deepEqual(await stageChunk('messages', 0, notifications.texts.messages), receipt('messages', 0, notifications.texts.messages));
    const p = await plan(); checkPlan(p); assert.ok(p.conflicts.includes('notification_target_not_empty'));
  });
  await noLegacy();
}));
for (const key of ['messages', 'broadcast_messages', 'message_templates'])
  test(`${key} source UUID collision blocks without replacing unrelated target content`, () => transaction(async () => {
    await stage();
    if (key === 'messages') await change('public.messages', `INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,audit_origin,delivery_mode)
      VALUES($1,$2,'root','unrelated target','keep me','realtime','normal','manual_admin','realtime_only')`, [N.manual, NEW.root]);
    if (key === 'broadcast_messages') await change('public.broadcast_messages', "INSERT INTO public.broadcast_messages(id,admin_id,message_content,message_type,target_type) VALUES($1,$2,'keep me','text','all')", [N.broadcast, NEW.root]);
    if (key === 'message_templates') await change('public.message_templates', "INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority) VALUES($1,$2,'unrelated name','target','keep me','realtime','normal')", [N.template, NEW.root]);
    await unchanged(async () => { const p = await plan(); checkPlan(p); assert.ok(p.conflicts.includes('notification_uuid_collision'), JSON.stringify(p.conflicts)); assert.deepEqual((await status()).plan, p); });
  }));
test('mapped reward actual transaction corruption blocks all entry points; source links cannot mask target drift', () => transaction(async () => {
  await stage();
  // Use a new reference, not the existing manual reference (which is protected by a real unique index).
  const changed = await change('public.wallet_transactions', "UPDATE public.wallet_transactions SET reference_id=$2 WHERE type='performance_bonus' AND reference_id=$1 RETURNING id", [N.autoRecipient, id(995)]);
  assert.equal(changed.length, 1); await denyAll();
}));
test('missing target date capability is not created/normalized by plan/status or writes', () => transaction(async () => {
  await stage(); await db.exec('DROP TABLE public.notification_automation_date_runs');
  const saved = await snapshot(), modes = await triggers();
  // Existing ALWAYS inventory may reject before a conflict plan can be built. Either must stay closed.
  // Catch only the RPC, never our assertions (otherwise an absent conflict could be hidden).
  let p = null;
  try { p = await plan(); }
  catch (error) { assert.match(error.message, /mapped notifications|maintenance|inventory|schema|date/i); }
  if (p !== null) {
    checkPlan(p); assert.ok(p.conflicts.includes('unsupported_date_runs'));
    assert.deepEqual((await status()).plan, p);
  } else await assert.rejects(status());
  await assert.rejects(bind()); await assert.rejects(stageChunk('messages', 0, notifications.texts.messages));
  assert.equal(await scalar(db, "SELECT to_regclass('public.notification_automation_date_runs') IS NULL"), true);
  assert.deepEqual(await snapshot(), saved); assert.deepEqual(await triggers(), modes);
}));
test('real cancellation revokes continuation, keeps written prerequisites/funds and never releases dirty maintenance', () => transaction(async () => {
  await stage();
  const before = (await snapshot()).filter(r => !r.name.startsWith('private.employee_transfer_'));
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  assert.equal((await rpc('employee_transfer_cancel', auth())).success, true);
  assert.deepEqual((await snapshot()).filter(r => !r.name.startsWith('private.employee_transfer_')), before);
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance); await denyAll();
}));
for (const lost of ['bind', 'stage']) test(`COMMIT then lost ${lost} reply: reopen dump and explicitly status, never replay a write automatically`, () => withClone(readyDump, async () => {
  const calls = []; let discarded;
  const transport = async (op, extra) => {
    calls.push(op);
    const value = await transaction(() => call(op, extra), db, true);
    if (op === lost) { discarded = value; throw new Error('synthetic response lost AFTER actual COMMIT'); }
    return value;
  };
  if (lost === 'stage') await transaction(() => bind(), db, true);
  const extra = lost === 'bind' ? { p_catalog: notifications.catalog } : { p_table_key: 'messages', p_chunk_no: 0, p_ndjson: notifications.texts.messages };
  await assert.rejects(transport(lost, extra), /AFTER actual COMMIT/); assert.deepEqual(calls, [lost]);
  const dump = await db.dumpDataDir('none');
  await withClone(dump, async () => {
    await transaction(async () => {
      await db.exec('SET TRANSACTION READ ONLY');
      await unchanged(async () => {
        calls.push('status'); const s = checkStatus(await status(lost === 'stage' ? 'messages' : null, lost === 'stage' ? 0 : null), notifications, { complete: false });
        if (lost === 'bind') { assert.equal(s.catalog_hash, discarded.catalog_hash); assert.equal(s.chunk, null); }
        else assert.deepEqual(s.chunk, chunkReceipt('messages', 0, notifications.texts.messages));
      });
    });
    assert.deepEqual(calls, [lost, 'status']);
    // Only after explicit reconciliation does the operator intentionally send remaining chunks.
    await transaction(async () => {
      for (const key of KEYS) {
        if (lost === 'stage' && key === 'messages') continue;
        await stageChunk(key, 0, notifications.texts[key]);
      }
      const p = await plan(); checkPlan(p); assert.deepEqual(p.conflicts, []); checkStatus(await status()); await noLegacy();
    }, db, true);
  });
}));

// New integrity regression: changing BOTH sender and execution owner must not bypass task ownership.
// Only untrusted notification raw input is changed. Real SQL48–53 and original finance remain intact.
test('execution and sender cannot collude on another mapped admin while task/employee belong to the original owner', () => transaction(async () => {
  const input = altered({
    notification_automation_executions: patchRow(r => r.id === N.execution, { owner_admin_id: NEW.root }),
    messages: patchRow(r => r.id === N.automatic, { sender_id: NEW.root }),
  });
  await stage(input);
  await unchanged(async () => {
    const p = await plan(); checkPlan(p, input);
    assert.ok(p.conflicts.includes('source_scope_mismatch'), `Cross-owner execution accepted: ${JSON.stringify(p.conflicts)}`);
    assert.deepEqual((await status()).plan, p);
  });
}));

let clientModule;
async function clientWith(transport) {
  if (!clientModule) {
    const compiled = await build({ stdin: { contents: `export {createEmployeeMappedNotificationsSession} from './src/lib/employeeTransfer/employeeMappedNotifications.ts';
      export {setHarness} from 'mapped-notifications-db:state';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', plugins: [{ name: 'local-mapped-notifications-client', setup(builder) {
        builder.onResolve({ filter: /^(?:mapped-notifications-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'mapped-notifications-db' }));
        builder.onLoad({ filter: /.*/, namespace: 'mapped-notifications-db' }, ({ path }) => ({ contents: path === 'mapped-notifications-db:state'
          ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
          : path === '../auth' ? 'import{current}from"mapped-notifications-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
            : 'import{current}from"mapped-notifications-db:state";export const supabase={rpc:(name,args)=>current().rpc(name,args)};' }));
      } }] });
    clientModule = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  }
  clientModule.setHarness({ token: session, rpc: transport });
  return clientModule.createEmployeeMappedNotificationsSession(task.job_token);
}
function queryFor(run) {
  // Start once, just like a single SDK request; multiple then observers cannot resend SQL.
  let pending;
  const query = { then(resolve, reject) { pending ??= Promise.resolve().then(run); return pending.then(resolve, reject); }, abortSignal() { return query; } };
  return query;
}
for (const lost of ['bind', 'stage']) test(`real client to anon RPC: committed ${lost} response lost, exact status reconciliation and zero automatic retries`, () => withClone(readyDump, async () => {
  const calls = []; let drop = true;
  const client = await clientWith((name, args) => queryFor(async () => {
    calls.push({ name, args });
    const data = await transaction(() => rpc(name, args), db, true);
    if (name === PREFIX + lost && drop) { drop = false; return { data: null, error: { message: 'response lost after actual COMMIT' } }; }
    return { data, error: null };
  }));
  if (lost === 'stage') await client.bind(notifications.catalog);
  await assert.rejects(lost === 'bind' ? client.bind(notifications.catalog) : client.stage('messages', 0, notifications.texts.messages), /unconfirmed/);
  assert.equal(drop, false);
  const n = calls.length;
  await assert.rejects(client.bind(notifications.catalog), /unconfirmed/);
  await assert.rejects(client.stage('messages', 0, notifications.texts.messages), /unconfirmed/);
  assert.equal(calls.length, n, 'An unconfirmed write cannot be retried automatically.');
  if (lost === 'stage') {
    const wrong = await client.status('broadcast_messages', 0); assert.equal(wrong.chunk, null);
    const afterWrong = calls.length;
    await assert.rejects(client.stage('broadcast_messages', 0, notifications.texts.broadcast_messages), /unconfirmed/);
    assert.equal(calls.length, afterWrong, 'Wrong-chunk status must not unlock the pending stage.');
    const s = await client.status('messages', 0); assert.deepEqual(s.chunk, chunkReceipt('messages', 0, notifications.texts.messages));
  } else {
    const s = await client.status(); assert.equal(s.bound, true); assert.equal(s.complete, false);
  }
  for (const key of KEYS) {
    if (lost === 'stage' && key === 'messages') continue;
    await client.stage(key, 0, notifications.texts[key]);
  }
  const p = await client.plan(); checkPlan(p); assert.deepEqual(p.conflicts, []);
  checkStatus(await client.status());
  assert.equal(calls.filter(c => c.name === PREFIX + lost).length, lost === 'stage' ? 13 : 1);
  for (const c of calls) { assert.equal(c.args.p_admin_session_token, session); assert.equal(c.args.p_job_token, task.job_token); }
  await transaction(noLegacy);
}));
test('real client cancellation keeps mutex until the actual pending stage commits, then requires exact status', () => withClone(readyDump, async () => {
  const calls = []; let blocked = false, enter, release, underlying;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const client = await clientWith((name, args) => queryFor(() => {
    const run = (async () => {
      calls.push({ name, args });
      if (name === PREFIX + 'stage' && !blocked) { blocked = true; enter(); await gate; }
      const data = await transaction(() => rpc(name, args), db, true); return { data, error: null };
    })();
    if (name === PREFIX + 'stage') underlying = run;
    return run;
  }));
  await client.bind(notifications.catalog);
  const abort = new AbortController();
  const pending = client.stage('messages', 0, notifications.texts.messages, abort.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered; abort.abort(); await rejected;
  try {
    const n = calls.length;
    await assert.rejects(client.status('messages', 0), /unconfirmed/);
    await assert.rejects(client.bind(notifications.catalog), /unconfirmed/);
    assert.equal(calls.length, n, 'Abort cannot release the mutex while the actual RPC remains unfinished.');
  } finally { release(); }
  // Await the exact pending SDK transport, then let the client's finally microtasks drain.
  // No timing assumption, status polling, write retry or pretend cancellation of the SQL.
  assert.ok(underlying); await underlying;
  await new Promise(resolve => setImmediate(resolve));
  const s = await client.status('messages', 0);
  assert.deepEqual(s.chunk, chunkReceipt('messages', 0, notifications.texts.messages));
  assert.equal(calls.filter(c => c.name === PREFIX + 'stage').length, 1);
  for (const key of KEYS.filter(k => k !== 'messages')) await client.stage(key, 0, notifications.texts[key]);
  const p = await client.plan(); checkPlan(p); assert.deepEqual(p.conflicts, []); await transaction(noLegacy);
}));

// Configuration UUIDs are not unconditional conflicts: exact old SQL25 correspondence is deferred
// to the future configuration plan. These are pre-existing TARGET business fixtures only, installed
// inside a rollback transaction; all guards are restored before any public SQL54 RPC is invoked.
// Source exports, the real SQL48–53 chain, server mappings and backup proof are never rewritten.
async function targetConfiguration(kind, variant = 'matching') {
  const owner = variant === 'other-admin' ? (kind === 'message_templates' ? NEW.branch : NEW.root)
    : kind === 'message_templates' ? NEW.root : NEW.branch;
  if (kind === 'notification_automation_plans') {
    await change('public.notification_automation_plans', `INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,description,status,activated_at)
      VALUES($1,$2,'來源方案 ALPHA','target-only description must survive','paused',NULL)`, [N.plan, owner]);
  } else if (kind === 'message_templates') {
    await change('public.message_templates', `INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority,delivery_mode)
      VALUES($1,$2,'無收件人的範本','target-only title','<p>target-only content must survive</p>','realtime','normal','realtime_only')`, [N.template, owner]);
  } else {
    assert.equal(kind, 'notification_automation_tasks');
    // Same parent UUID for the positive case. For the other-admin case the parent is a separate,
    // same-named plan owned by that admin, keeping the fixture's real parent/owner relationship valid.
    // The wrong-parent case preserves the correct admin/name/shared flag and changes only the parent.
    const parent = variant === 'matching' ? N.plan : id(350);
    const parentName = variant === 'other-parent' ? 'target unrelated parent' : '來源方案 ALPHA';
    await change('public.notification_automation_plans', `INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,description,status,activated_at)
      VALUES($1,$2,$3,'target-only parent must survive','paused',NULL)`, [parent, owner, parentName]);
    await change('public.notification_automation_tasks', `INSERT INTO public.notification_automation_tasks(id,owner_admin_id,name,plan_id,is_shared_template,
        status,trigger_type,trigger_mode,threshold_value,recipient_scope,title_template,content_template,reward_enabled,reward_amount,delivery_mode)
      VALUES($1,$2,'循環獎勵',$3,false,'paused','total_orders','recurring',99,'selected',
        'target-only title','<p>target-only task content must survive</p>',false,NULL,'realtime_only')`, [N.task, owner, parent]);
  }
}
for (const kind of ['notification_automation_plans', 'notification_automation_tasks', 'message_templates'])
  test(`${kind}: same UUID, mapped admin and old-rule name/parent/shared match remain pending, never applied`, () => transaction(async () => {
    await stage(); await targetConfiguration(kind);
    const wantedId = kind === 'notification_automation_plans' ? N.plan : kind === 'notification_automation_tasks' ? N.task : N.template;
    const original = await scalar(db, `SELECT to_jsonb(r) FROM public.${kind} r WHERE id=$1`, [wantedId]);
    assert.ok(original);
    if (kind === 'message_templates') assert.equal(original.admin_id, NEW.root);
    else assert.equal(original.owner_admin_id, NEW.branch, 'Use the real mapped target admin, not source branch UUID.');
    if (kind === 'notification_automation_tasks') { assert.equal(original.plan_id, N.plan); assert.equal(original.is_shared_template, false); }
    await unchanged(async () => {
      const p = await plan(); checkPlan(p); assert.deepEqual(p.conflicts, []);
      assert.equal(p.configuration_pending, true); assert.equal(p.records_pending, true);
      assert.deepEqual((await status()).plan, p);
      assert.equal((await bind()).success, true);
      assert.deepEqual(await stageChunk(kind, 0, notifications.texts[kind]), receipt(kind, 0, notifications.texts[kind]));
    });
    assert.deepEqual(await scalar(db, `SELECT to_jsonb(r) FROM public.${kind} r WHERE id=$1`, [wantedId]), original);
    await noLegacy();
  }));
for (const [kind, variant] of [
  ['notification_automation_plans', 'other-admin'],
  ['notification_automation_tasks', 'other-parent'],
  ['notification_automation_tasks', 'other-admin'],
]) test(`${kind}: same UUID/name but ${variant} is a collision, never an allowed overwrite`, () => transaction(async () => {
  await stage(); await targetConfiguration(kind, variant);
  await unchanged(async () => {
    const p = await plan(); checkPlan(p); assert.deepEqual(p.conflicts, ['notification_uuid_collision']);
    const s = checkStatus(await status()); assert.deepEqual(s.plan, p);
    assert.equal(p.configuration_pending, true);
    // Conflicted raw staging is allowed, but must neither mutate business nor erase the conflict.
    assert.equal((await bind()).success, true);
    assert.deepEqual(await stageChunk(kind, 0, notifications.texts[kind]), receipt(kind, 0, notifications.texts[kind]));
    assert.deepEqual(await plan(), p);
  });
  await noLegacy();
}));

// Three independently reviewed source-link regressions. Only caller-controlled notification bytes
// and their wire catalog are changed; original identity/finance exports, real SQL48–53 prerequisites,
// admin/employee mappings, source database, server summary and business rows must remain unchanged.
for (const [label, changes, expectedConflict, inspect] of [
  ['NULL-owner failed execution cannot link branch task/plan to root employee', {
    notification_automation_executions: patchRow(r => r.id === N.historical, { task_id: N.task, plan_id: N.plan, user_id: S.two }),
  }, 'source_scope_mismatch', input => {
    const r = lines(input.texts.notification_automation_executions).map(JSON.parse).find(r => r.id === N.historical);
    assert.deepEqual([r.status, r.owner_admin_id, r.task_id, r.plan_id, r.user_id, r.message_id, r.wallet_transaction_id],
      ['failed', null, N.task, N.plan, S.two, null, null]);
    const taskRow = lines(input.texts.notification_automation_tasks).map(JSON.parse).find(r => r.id === N.task);
    const planRow = lines(input.texts.notification_automation_plans).map(JSON.parse).find(r => r.id === N.plan);
    const employee = lines(identity.texts.accounts).map(JSON.parse).find(r => r.id === S.two);
    assert.equal(taskRow.owner_admin_id, S.branch); assert.equal(planRow.owner_admin_id, S.branch);
    assert.equal(employee.created_by, NEW.root); assert.notEqual(S.branch, NEW.root);
  }],
  ['manual reward sender cannot differ from the non-NULL original finance created_by', {
    messages: patchRow(r => r.id === N.manual, { sender_id: NEW.root }),
  }, 'reward_link_mismatch', input => {
    const m = lines(input.texts.messages).map(JSON.parse).find(r => r.id === N.manual);
    const bonus = lines(finance.texts.wallet_transactions).map(JSON.parse)
      .find(r => r.type === 'performance_bonus' && r.reference_id === N.manualRecipient);
    assert.equal(m.audit_origin, 'manual_admin'); assert.equal(m.automation_execution_id, null);
    assert.equal(m.sender_id, NEW.root); assert.equal(bonus.created_by, S.branch); assert.equal(bonus.user_id, S.one);
    assert.notEqual(m.sender_id, bonus.created_by);
    assert.ok(input.texts.messages.includes(MANUAL_REWARD), 'Do not round/rewrite the reward amount to create the mismatch.');
  }],
  ['failed execution with non-NULL message_id must be reverse-linked, not hijack a manual message', {
    notification_automation_executions: patchRow(r => r.id === N.historical, { message_id: N.manual }),
  }, 'reward_link_mismatch', input => {
    const r = lines(input.texts.notification_automation_executions).map(JSON.parse).find(r => r.id === N.historical);
    const m = lines(input.texts.messages).map(JSON.parse).find(r => r.id === N.manual);
    assert.equal(r.status, 'failed'); assert.equal(r.message_id, N.manual);
    for (const field of ['task_id', 'plan_id', 'owner_admin_id', 'user_id', 'wallet_transaction_id']) assert.equal(r[field], null);
    assert.equal(m.audit_origin, 'manual_admin'); assert.equal(m.automation_execution_id, null);
  }],
]) test(label, () => transaction(async () => {
  const input = altered(changes); inspect(input);
  assert.deepEqual(input.catalog.identity_catalog, identity.catalog);
  assert.deepEqual(input.catalog.finance_catalog, finance.catalog);
  for (const key of KEYS) {
    const changed = Object.hasOwn(changes, key), expected = notifications.catalog.tables.find(t => t.key === key);
    const actual = input.catalog.tables.find(t => t.key === key);
    assert.equal(actual.rows, expected.rows, 'The regression changes references, not row counts.');
    if (changed) {
      assert.notEqual(input.texts[key], notifications.texts[key]);
      assert.notEqual(actual.row_hashes_sha256, expected.row_hashes_sha256, 'Recompute the raw notification catalog.');
    } else { assert.equal(input.texts[key], notifications.texts[key]); assert.deepEqual(actual, expected); }
  }
  const before = await snapshot(), modes = await triggers(), sourceBefore = await snapshot(source);
  await stage(input);
  const changedTables = (await snapshot()).filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).map(r => r.name);
  assert.deepEqual(changedTables, ['private.employee_transfer_staging'], 'No prerequisite/business/summary writes are permitted.');
  await unchanged(async () => {
    const p = await plan(); checkPlan(p, input); assert.deepEqual(p.conflicts, [expectedConflict]);
    const s = checkStatus(await status(), input); assert.deepEqual(s.plan, p);
  });
  assert.deepEqual(await snapshot(source), sourceBefore); assert.deepEqual(await triggers(), modes); await noLegacy();
}));

console.log(`SQL54 registered ${caseNo} unique cases; executing ${selectedCases}. No excluded case is a pass.`);
assert.ok(selectedCases > 0, 'Explicit range selected no cases.');
if (range) assert.ok(range[1] <= caseNo, `Range exceeds ${caseNo} cases.`);
