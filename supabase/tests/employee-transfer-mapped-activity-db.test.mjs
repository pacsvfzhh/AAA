import assert from 'node:assert/strict';
import { after, before, mock, test as registerTest } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
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

// Only the mapped-activity database test is changed. Real SQL replay, source exports, independent disk
// AES/ZIP backups and SQL48/49/50/51 RPCs establish ALL positive prerequisites.
// Direct postgres changes are local business fixtures or explicitly negative corruption.
// No production network, manufactured jobs/maps/verified summaries or backup proof.
// PGlite is not native PostgreSQL concurrency, PostgREST, Storage or capacity acceptance.
// Optional, explicit grouping for slow PGlite scans. No range = the whole file.
// e.g. EMPLOYEE_MAPPED_ACTIVITY_DB_RANGE=1-20 / 21-40 / 41-60, separately.
// node --test supabase/tests/employee-transfer-mapped-activity-db.test.mjs
// No SQL is skipped: every group still performs the complete strict replay and prerequisites.
const rangeText = process.env.EMPLOYEE_MAPPED_ACTIVITY_DB_RANGE;
let range = null, caseNo = 0, selectedCases = 0;
if (rangeText !== undefined) {
  assert.match(rangeText, /^[1-9][0-9]*-[1-9][0-9]*$/);
  range = rangeText.split('-').map(Number);
  assert.ok(range.every(Number.isSafeInteger) && range[0] <= range[1]);
  console.log(`Explicit SQL52 test selection ${rangeText}; excluded cases are NOT counted as passed.`);
}
function test(name, fn) {
  caseNo++;
  if (range && (caseNo < range[0] || caseNo > range[1])) return;
  selectedCases++; return registerTest(name, fn);
}
const MIGRATION = '20261102000052_restore_mapped_employee_activity.sql';
const PREFIX = 'employee_import_mapped_activity_';
const OPERATIONS = ['bind', 'stage', 'plan', 'begin', 'apply', 'status', 'verify'];
const FINANCE = ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'];
const ACTIVITY = ['employee_login_history', 'work_sessions', 'work_stop_markers'];
const RELATIONS = { employee_login_history: 'public.employee_login_history', work_sessions: 'public.work_sessions', work_stop_markers: 'private.employee_work_stop_markers' };
const TABLES = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'], finance: FINANCE, activity: ACTIVITY,
};
const ZERO = '00000000-0000-0000-0000-000000000000';
const STATE = 'mapped-activity-v1';
const DONE = 'mapped-activity-done-v1';
const GATES = ['can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
const COMMON = ['scope', 'job_id', 'site_id', 'source_site_id', 'package_id', 'catalog_hash', 'mapping_hash', 'plan_hash',
  'totals', 'employees', 'running_work_sessions', 'maintenance', 'dependencies_pending', 'financial_data_pending', ...GATES];
const CONFLICTS = ['source_employee_missing', 'work_duration_out_of_range', 'activity_target_not_empty', 'activity_uuid_collision'];
const id = n => `52000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { one: id(1), two: id(2), branch: id(3), group: id(4), product: id(5), unknownAdmin: id(6),
  memberOne: id(10), memberTwo: id(11), validMax: id(20), validNull: id(21), validSmall: id(22),
  tx: id(500), manual: id(501), pending: id(600), pendingExtra: id(601), pendingTwo: id(602),
  cursor: '9007199254740993', after: '9007199254740994', audit: '9007199254740999', unrelated: id(999) };
const EMPLOYEES = [S.one, S.two];
const OWNERS = [S.one, S.two, S.one, S.two];
const USERNAMES = { [S.one]: 'mapped-activity-one', [S.two]: 'mapped-activity-legacy' };
const PRECISE = '12345678901234567890.1234567890123456789';
const PENDING = '3.12345678901234567890123456789';
const AVAILABLE = '101.12345678901234567890123456789';
const TIME = '2030-03-04T05:06:07.654321Z';
const sha = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
function chunks(text, size = 200) {
  const result = []; let part = '', n = 0;
  for (const line of lines(text)) {
    if (n === size || Buffer.byteLength(part + line) > 262144) { result.push(part); part = ''; n = 0; }
    part += line; n++;
  }
  if (part || !result.length) result.push(part);
  return result;
}
let source, db, session, sourceSession, branch, emergency, other, pkg, task, sharedTask;
let identity, dispatch, shared, finance, activity, expected, modules, bindings, sharedDump, preFinanceDump, readyDump, readyTask, replay;
let counter = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function on(site, name, args, role = 'anon') {
  const point = `mapped_activity_${++counter}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const value = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return value;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
const rpc = (name, args, role) => on(db, name, args, role);
const call = (key, extra = {}, role = 'anon') => rpc(PREFIX + key, { ...auth(), ...extra }, role);
const bind = (input = activity, extra = {}, role) => call('bind', { p_catalog: input.catalog, ...extra }, role);
const stageChunk = (key, no, text, extra = {}, role) => call('stage', { p_table_key: key, p_chunk_no: no, p_ndjson: text, ...extra }, role);
const plan = (extra = {}, role) => call('plan', extra, role);
const status = (sourceId = null, extra = {}, role) => call('status', { p_source_id: sourceId, ...extra }, role);
const begin = (p, extra = {}, role) => call('begin', { p_plan_hash: p.plan_hash, ...extra }, role);
const apply = (p, sourceId = S.one, extra = {}, role) => call('apply', { p_source_id: sourceId, p_plan_hash: p.plan_hash, ...extra }, role);
const verify = (extra = {}, role) => call('verify', extra, role);
const argsFor = (op, p) => op === 'bind' ? { p_catalog: activity.catalog }
  : op === 'stage' ? { p_table_key: 'employee_login_history', p_chunk_no: 0, p_ndjson: chunks(activity.texts.employee_login_history)[0] }
    : op === 'begin' ? { p_plan_hash: p.plan_hash } : op === 'apply' ? { p_source_id: S.one, p_plan_hash: p.plan_hash }
      : op === 'status' ? { p_source_id: null } : {};
const summary = () => scalar(db, 'SELECT summary FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]);
const permits = () => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits');
async function transaction(fn, site = db, commit = false) {
  await site.exec('BEGIN');
  try { const result = await fn(); await site.exec(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
  catch (error) { await site.exec('ROLLBACK'); throw error; }
}
async function clone(dump) {
  const site = new PGlite({ loadDataDir: dump, extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await site.waitReady; return site;
}
async function withClone(dump, job, fn) {
  const previous = { db, task, bindings }; const site = await clone(dump); db = site; task = job;
  try { return await fn(); }
  finally { db = previous.db; task = previous.task; bindings = previous.bindings; await site.close(); }
}
async function capture(kind) {
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession,
    p_admin_password: PASSWORDS.root, ...['identity', 'finance', 'activity'].includes(kind) ? { p_package_id: pkg } : {} });
  assert.equal(job.success, true);
  const texts = {};
  for (const key of TABLES[kind]) {
    texts[key] = ''; let after = null;
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 1 });
      assert.equal(page.sha256, sha(page.ndjson)); texts[key] += page.ndjson; after = page.next_after;
    } while (after !== null);
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  return { catalog: job.catalog, texts };
}
async function* readDisk(path) {
  const handle = await open(path, 'r');
  try { const bytes = Buffer.alloc(65521); for (;;) { const part = await handle.read(bytes); if (!part.bytesRead) return; yield bytes.subarray(0, part.bytesRead); } }
  finally { await handle.close(); }
}
async function prepare(kind, input) {
  const job = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg, p_catalog: input.catalog,
  });
  for (const key of TABLES[kind]) for (const [no, text] of chunks(input.texts[key], 2).entries())
    await rpc(`employee_import_${kind}_stage`, { ...auth(job), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const p = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job));
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(job));
  const dir = await mkdtemp(join(tmpdir(), 'employee-mapped-activity-')), path = join(dir, 'independent.edx'), plain = new Map();
  let opens = 0;
  try {
    const result = await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(job))).catalog; },
      page(key, after) { return rpc(`get_employee_import_${kind}_backup_page`, { ...auth(job), p_table_key: key, p_after: after, p_limit: 200 }); },
      async verify() {
        // No standalone backup verify RPC; compare a fresh complete SQL descriptor.
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(job)), descriptor);
        return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
      },
    }, {
      async append(name, bytes) { plain.set(name, [...plain.get(name) ?? [], Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) { const handle = await open(path, 'wx'); try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } },
      open() { opens++; return readDisk(path); },
    }, {
      append(no, hex) { assert.equal(opens, 2); return rpc(`employee_import_${kind}_backup_append`, { ...auth(job), p_plan_hash: p.plan_hash, p_chunk_no: no, p_hex: hex }); },
      seal(hash, bytes) { return rpc(`employee_import_${kind}_backup_seal`, { ...auth(job), p_plan_hash: p.plan_hash, p_sha256: hash, p_bytes: bytes }); },
    }, 'local-mapped-activity-independent-backup-passphrase');
    assert.equal(result.sealReceipt.success, true); assert.equal(plain.size, 0); assert.equal(opens, 2);
    assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), true);
    return { job, plan: p };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function configure(input) {
  const prepared = await prepare('dispatch', input); task = prepared.job;
  await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: prepared.plan.plan_hash,
    p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
  const p = await rpc('get_employee_import_dispatch_configuration_plan', auth());
  assert.equal((await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: p.plan_hash })).configuration_applied, true);
}
async function restoreValid() {
  const config = (await summary()).dispatch_config_plan;
  const started = await rpc('employee_import_dispatch_valid_begin', { ...auth(), p_plan_hash: config.plan_hash });
  for (let no = 0; no < started.chunks; no++) await rpc('employee_import_dispatch_valid_chunk', { ...auth(), p_chunk_no: no });
  assert.equal((await rpc('employee_import_dispatch_valid_verify', auth())).verified, true);
}
async function restoreIdentities(input = identity, employees = EMPLOYEES, { incomplete = null, omit = null } = {}) {
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: input.catalog });
  for (const key of TABLES.identity) for (const [no, text] of chunks(input.texts[key], 2).entries())
    await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  bindings = {};
  for (const sourceId of employees) {
    const observed = await rpc('employee_import_identity_reservation_status', { ...auth(), p_source_id: sourceId });
    assert.equal(observed.reservation, null);
    const r = await rpc('employee_import_identity_reserve', { ...auth(), p_source_id: sourceId,
      p_source_fingerprint: observed.observed.source_fingerprint, p_target_fingerprint: observed.observed.target_fingerprint });
    assert.equal(r.candidate_available, true); assert.equal(r.source_unchanged, true); assert.equal(r.target_unchanged, true);
    bindings[sourceId] = r.reservation; assert.notEqual(r.reservation.target_id, sourceId);
  }
  for (const sourceId of employees) {
    if (sourceId === omit) continue;
    const p = await rpc('employee_import_mapped_identity_plan', { ...auth(), p_source_id: sourceId });
    assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
    await rpc('employee_import_mapped_identity_core', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash });
    for (let no = 0; no < p.order_chunks; no++) await rpc('employee_import_mapped_identity_orders', { ...auth(), p_source_id: sourceId, p_chunk_no: no });
    if (sourceId !== incomplete) assert.equal((await rpc('employee_import_mapped_identity_verify', { ...auth(), p_source_id: sourceId })).verified, true);
  }
}
async function restoreDependencies({ incomplete = false } = {}) {
  const p = await rpc('employee_import_mapped_dependency_plan', auth()); assert.equal(p.can_begin, true);
  await rpc('employee_import_mapped_dependency_begin', { ...auth(), p_plan_hash: p.plan_hash });
  for (const key of ['dispatch_group_members', 'used_order_data']) for (let no = 0; no < p.chunks[key]; no++)
    await rpc('employee_import_mapped_dependency_chunk', { ...auth(), p_table_key: key, p_chunk_no: no });
  if (!incomplete) assert.equal((await rpc('employee_import_mapped_dependency_verify', auth())).verified, true);
}
// Explicitly local business setup/negative tampering. Restore EVERY original mode.
async function change(relation, sql, params = [], site = db) {
  const modes = await rows(site, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
  for (const t of modes) await site.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
  const point = `local_change_${++counter}`; let isolated = false;
  try { await site.exec(`SAVEPOINT ${point}`); isolated = true; } catch (error) { if (error.code !== '25P01') throw error; }
  try { await site.query(sql, params); }
  catch (error) { if (isolated) await site.exec(`ROLLBACK TO SAVEPOINT ${point}`); throw error; }
  finally { if (isolated) await site.exec(`RELEASE SAVEPOINT ${point}`); for (const t of modes) await site.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`); }
}
async function snapshot(site = db) {
  const names = (await rows(site, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(site, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}
async function unrelatedEmployee() {
  await change('public.users', `INSERT INTO public.users(id,username,password_hash,employee_id,created_by,is_active)
    VALUES($1,'unrelated-activity-target','local-only','MF-UNRELATED',$2,false)`, [S.unrelated, NEW.root]);
}
const business = () => snapshot().then(all => all.filter(r => r.name.startsWith('public.') || !r.name.startsWith('private.employee_transfer_')));
const triggers = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') ORDER BY 1,2,3`);
async function isolated(fn) {
  const point = `negative_activity_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
  try { return await fn(); } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
}
function counts(value) {
  assert.deepEqual(Object.keys(value).sort(), [...ACTIVITY].sort());
  for (const n of Object.values(value)) assert.ok(Number.isSafeInteger(n) && n >= 0);
}
function common(value, p = null) {
  const isPlan = Object.hasOwn(value, 'can_begin');
  assert.deepEqual(Object.keys(value).sort(), [...COMMON, ...isPlan ? ['can_begin', 'conflicts'] : ['started', 'completed_employees', 'verified', 'employee']].sort());
  assert.equal(value.scope, 'employee-mapped-activity'); assert.equal(value.job_id, task.job_id);
  assert.equal(value.package_id, pkg); assert.equal(value.source_site_id, activity.catalog.site_id);
  for (const key of ['job_id', 'site_id', 'source_site_id', 'package_id']) assert.match(value[key], /^[0-9a-f-]{36}$/);
  for (const key of ['catalog_hash', 'mapping_hash', 'plan_hash']) assert.match(value[key], /^[0-9a-f]{64}$/);
  for (const key of ['maintenance', 'dependencies_pending', 'financial_data_pending']) assert.equal(value[key], true);
  for (const key of GATES) assert.equal(value[key], false, key);
  counts(value.totals); assert.ok(Number.isSafeInteger(value.employees) && value.employees >= 0);
  assert.ok(Number.isSafeInteger(value.running_work_sessions) && value.running_work_sessions >= 0 && value.running_work_sessions <= value.totals.work_sessions);
  if (p) for (const key of COMMON) assert.deepEqual(value[key], p[key], key);
  if (isPlan) {
    assert.ok(Array.isArray(value.conflicts)); assert.equal(new Set(value.conflicts).size, value.conflicts.length);
    for (const reason of value.conflicts) assert.ok(CONFLICTS.includes(reason), reason);
    assert.equal(value.can_begin, value.conflicts.length === 0);
  } else {
    assert.equal(typeof value.started, 'boolean'); assert.equal(typeof value.verified, 'boolean');
    assert.ok(Number.isSafeInteger(value.completed_employees) && value.completed_employees >= 0 && value.completed_employees <= value.employees);
    if (value.employee !== null) {
      assert.deepEqual(Object.keys(value.employee).sort(), ['source_id', 'target_id', 'applied', 'counts'].sort());
      assert.equal(value.employee.target_id, bindings[value.employee.source_id].target_id);
      assert.equal(typeof value.employee.applied, 'boolean'); counts(value.employee.counts);
    }
  }
  assert.doesNotMatch(JSON.stringify(value), /password|session_token|job_token|identity_map|admin_map/);
}
async function stage(input = activity, role = 'anon') {
  const r = await bind(input, {}, role);
  assert.deepEqual(Object.keys(r).sort(), ['success', 'scope', 'catalog_hash', 'full_site_complete'].sort());
  assert.equal(r.success, true); assert.equal(r.scope, 'employee-mapped-activity'); assert.equal(r.full_site_complete, false);
  assert.match(r.catalog_hash, /^[0-9a-f]{64}$/);
  for (const key of ACTIVITY) for (const [no, text] of chunks(input.texts[key], 2).entries()) {
    assert.deepEqual(await stageChunk(key, no, text, {}, role), { success: true, scope: 'employee-mapped-activity', table_key: key, chunk_no: no,
      rows: lines(text).length, bytes: Buffer.byteLength(text), sha256: sha(text), full_site_complete: false });
  }
  const p = await plan({}, role); common(p); assert.equal(p.catalog_hash, r.catalog_hash); return p;
}
async function finish(p, employees = EMPLOYEES, role = 'anon') {
  await begin(p, {}, role);
  for (const sourceId of employees) { const r = await apply(p, sourceId, {}, role); common(r, p); assert.equal(r.employee.applied, true); }
  const result = await verify({}, role); common(result, p); assert.equal(result.verified, true); return result;
}
async function restoreFinance({ applied = EMPLOYEES, verified = true } = {}) {
  const prefix = 'employee_import_mapped_finance_';
  await rpc(prefix + 'bind', { ...auth(), p_catalog: finance.catalog });
  for (const key of FINANCE) for (const [no, text] of chunks(finance.texts[key], 2).entries())
    await rpc(prefix + 'stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const p = await rpc(prefix + 'plan', auth()); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
  await rpc(prefix + 'begin', { ...auth(), p_plan_hash: p.plan_hash });
  for (const sourceId of applied) assert.equal((await rpc(prefix + 'apply', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash })).employee.applied, true);
  if (verified) assert.equal((await rpc(prefix + 'verify', auth())).verified, true);
}
async function noLegacy() {
  const s = await summary();
  for (const key of ['identity_restore', 'dependency_restore', 'verified_identity_map', 'finance_catalog', 'finance_plan', 'finance_restore', 'activity_catalog', 'activity_plan', 'activity_restore']) assert.equal(s[key], undefined, key);
  assert.equal(await permits(), 0);
}
async function denyAll(p, extra = {}, pattern, operations = OPERATIONS) {
  const frozen = await snapshot(), modes = await triggers();
  for (const role of ['anon', 'authenticated']) for (const op of operations)
    await assert.rejects(call(op, { ...argsFor(op, p), ...extra }, role), pattern);
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
}
async function expectedActivity() {
  // Independently project actual source BUSINESS rows. No SQL52 expected/source/parse helper.
  // JSONB stays PostgreSQL text throughout, retaining exact numeric/device/microsecond values.
  return {
    employee_login_history: await rows(source, `SELECT id::text,user_id::text AS owner,(to_jsonb(r)||jsonb_build_object(
      'device_info_is_sql_null',device_info IS NULL,'session_id',CASE WHEN session_id IS NULL THEN NULL ELSE
      'history-'||encode(extensions.digest(convert_to($1||':'||user_id::text||':'||session_id,'UTF8'),'sha256'),'hex') END))::text AS body
      FROM public.employee_login_history r ORDER BY id`, [activity.catalog.site_id]),
    work_sessions: await rows(source, `SELECT id::text,user_id::text AS owner,(to_jsonb(r)||CASE WHEN end_time IS NULL THEN jsonb_build_object(
      'end_time',GREATEST(start_time,COALESCE(last_heartbeat_at,start_time)),
      'duration_minutes',GREATEST(round(extract(epoch FROM (GREATEST(start_time,COALESCE(last_heartbeat_at,start_time))-start_time))/60)::integer,0))
      ELSE '{}'::jsonb END)::text AS body FROM public.work_sessions r ORDER BY id`),
    work_stop_markers: await rows(source, `SELECT user_id::text AS id,user_id::text AS owner,
      (to_jsonb(r)||jsonb_build_object('id',user_id))::text AS body FROM private.employee_work_stop_markers r ORDER BY user_id`),
  };
}
async function assertActivity(original = expected, employees = EMPLOYEES) {
  for (const sourceId of employees) {
    const target = bindings[sourceId].target_id;
    for (const key of ACTIVITY) {
      const originals = original[key].filter(r => r.owner === sourceId);
      assert.equal(await scalar(db, `SELECT count(*)::integer FROM ${RELATIONS[key]} WHERE user_id=$1`, [target]), originals.length, key);
      for (const row of originals) {
        const actual = key === 'employee_login_history' ? "to_jsonb(r)||jsonb_build_object('device_info_is_sql_null',device_info IS NULL)"
          : key === 'work_stop_markers' ? "to_jsonb(r)||jsonb_build_object('id',user_id)" : 'to_jsonb(r)';
        const projected = "$2::jsonb||jsonb_build_object('user_id',$1::uuid)" + (key === 'work_stop_markers' ? "||jsonb_build_object('id',$1::uuid)" : '');
        assert.equal(await scalar(db, `SELECT count(*)=1 FROM ${RELATIONS[key]} r WHERE user_id=$1 AND (${actual})=(${projected})`, [target, row.body]), true, `${key}:${row.id}`);
      }
      assert.equal(await scalar(db, `SELECT count(*)::integer FROM ${RELATIONS[key]} WHERE user_id=$1`, [sourceId]), 0, 'source UUID must not receive target rows');
    }
  }
}
async function sourceVariant(mutate, run, compare = true) {
  const input = await transaction(async () => { await mutate(); const a = await capture('activity'); const previous = activity; activity = a;
    try { return { activity: a, expected: compare ? await expectedActivity() : null }; } finally { activity = previous; }
  }, source);
  const previous = activity; activity = input.activity;
  try { return await transaction(() => run(input)); } finally { activity = previous; }
}
async function seedActivity() {
  // Deliberately inconsistent historical duration/heartbeat values are legal original rows.
  // Only source business fixture triggers are temporarily bypassed; never fabricate transfer state.
  await change('public.employee_login_history', `INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,ip_address,user_agent,session_id,created_at,device_info)
    SELECT ('52000000-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,CASE WHEN n=7 THEN $2::uuid ELSE $1::uuid END,
      '歷史名稱𠮷 é é','歷史員工號-0042',CASE WHEN n%2=0 THEN 'logout' ELSE 'login' END,
      CASE WHEN n=2 THEN NULL ELSE '2001:db8::1' END,CASE WHEN n=2 THEN NULL ELSE E'UA \\n{} " \\t' END,
      CASE WHEN n=2 THEN NULL ELSE 'source-live-session-never-import' END,CASE WHEN n=2 THEN NULL ELSE '2023-02-03T04:05:06.654321Z'::timestamptz END,
      CASE n WHEN 1 THEN ('{"children":[{"id":"left","precise":'||$3||'},{"id":"right"}],"nested":{"id":"device"}}')::jsonb
      WHEN 2 THEN NULL WHEN 3 THEN 'null'::jsonb WHEN 4 THEN $3::jsonb WHEN 5 THEN '"文字𠮷"'::jsonb WHEN 6 THEN '[]'::jsonb ELSE 'true'::jsonb END
    FROM generate_series(1,7) x(n)`, [S.one, S.two, PRECISE], source);
  await change('public.work_sessions', `INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,created_at,last_heartbeat_at)
    SELECT ('52000000-0000-4000-8000-'||lpad(to_hex(2000+n),12,'0'))::uuid,CASE WHEN n=6 THEN $2::uuid ELSE $1::uuid END,
      '2023-01-01T00:00:00.123456Z'::timestamptz+n*interval '1 day',
      CASE WHEN n IN (1,6) THEN NULL ELSE '2023-01-01T00:01:30.987654Z'::timestamptz+n*interval '1 day' END,
      CASE WHEN n=5 THEN NULL ELSE 777 END,CASE WHEN n IN (2,5) THEN NULL ELSE '2020-01-02T03:04:05.654321Z'::timestamptz END,
      CASE WHEN n IN (2,5) THEN NULL WHEN n=3 THEN '2022-12-31T23:59:59.123456Z'::timestamptz+n*interval '1 day'
      WHEN n=6 THEN '2023-01-01T00:00:30.123455Z'::timestamptz+n*interval '1 day'
      ELSE '2023-01-01T00:01:30.987654Z'::timestamptz+n*interval '1 day' END FROM generate_series(1,6) x(n)`, [S.one, S.two], source);
  await change('private.employee_work_stop_markers', `INSERT INTO private.employee_work_stop_markers(user_id,stopped_at)
    VALUES($1,'2023-04-05T06:07:08.123456Z'),($2,'2024-02-29T12:34:56.654321Z')`, [S.one, S.two], source);
}

before(async () => {
  // Missing SQL52 is a hard failure, not a skip and not an invented implementation.
  await access(new URL(`../migrations/${MIGRATION}`, import.meta.url));
  for (const [module, names] of [[globalThis, ['fetch']], [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [tls, ['connect']]])
    for (const name of names) mock.method(module, name, () => assert.fail('network and production services forbidden'));
  replay = await createSites({ upTo: MIGRATION }); source = replay.oldSite; db = replay.newSite;
  assert.equal(replay.files.at(-1), MIGRATION); assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await source.query('DELETE FROM public.financial_admin_credentials WHERE admin_id=$1', [NEW.branch]);
  await source.query('UPDATE public.admins SET id=$1 WHERE id=$2', [S.branch, NEW.branch]);
  await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [S.branch]);
  await source.query("INSERT INTO public.dispatch_groups(id,group_name,created_by) VALUES($1,'Mapped activity source group',$2)", [S.group, S.branch]);
  for (const sourceId of EMPLOYEES) {
    await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,total_income,remarks,created_at)
      VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5,true,$6::numeric,$7,'2026-09-01T01:02:03.123456Z')`,
    [sourceId, USERNAMES[sourceId], sourceId === S.one ? 'MF-001' : 'MF-002', PASSWORDS.employee, sourceId === S.one ? NEW.root : S.branch,
      sourceId === S.one ? '32.12345678901234567890123456789' : '0', sourceId === S.one ? 'private source remark é 𠮷' : null]);
    await source.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [sourceId]);
  }
  await source.query("INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Mapped activity historical product',false)", [S.product]);
  for (const [n, owner] of OWNERS.entries()) await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,
    product_value,order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at)
    VALUES($1,$2,$3,$4,99.9,$5,$6,$7,$8::numeric,$9::numeric,'2026-09-04T01:02:03.123456Z',$10::timestamptz)`,
  [id(100 + n), owner, USERNAMES[owner], S.product, `PRIVATE-MF-ORDER-${n}`, `PRIVATE-MF-TX-${n}`, n % 2 ? 'failure' : 'success',
    n % 2 ? null : PRECISE, n % 2 ? null : '0.1234567890123456789', n % 2 ? null : '2026-09-05T02:03:04.654321Z'], source);
  await source.query(`INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at) VALUES
    ($1,$2,$3,$4,'2021-01-02T03:04:05.123456Z'),($5,$6,$7,$8,NULL)`, [S.memberOne, NEW.groupA, S.one, NEW.root, S.memberTwo, S.group, S.two, S.branch]);
  for (const [n, valid] of [S.validMax, S.validNull, S.validSmall].entries()) await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count,last_used_at,tags,priority)
    VALUES($1,$2::numeric,$3,$4,0,NULL,$5::text[],$6)`, [valid, PRECISE, `source-valid-é-𠮷-${n}`, n % 2 ? S.branch : NEW.root, n ? null : ['é', null, '', 'é'], n]);
  for (const [n, owner] of OWNERS.entries()) await source.query(`INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
    VALUES($1,$2,$3,$4,$5::timestamptz)`, [id(200 + n), owner, [S.validMax, S.validNull, S.validSmall, S.validMax][n], id(100 + n), n === 1 ? null : '2021-03-04T05:06:07.123456Z']);
  await source.query(`UPDATE public.valid_order_data SET usage_count=CASE id WHEN $1 THEN 2147483647 WHEN $2 THEN NULL ELSE 17 END,
    last_used_at=CASE id WHEN $2 THEN NULL ELSE $3::timestamptz END`, [S.validMax, S.validNull, TIME]);
  await transaction(async () => {
    await change('public.wallet_transactions', `INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,reference_id,remarks,created_by,created_at,operation_id)
      VALUES($1,$2,'commission',32.12345678901234567890123456789,0,32.12345678901234567890123456789,$3,NULL,$4,'2023-02-03T04:05:06.654321Z',$5),
      ($6,$2,'manual_adjustment',1.1234567890123456789,32,33.1234567890123456789,NULL,E'來源備註\\n𠮷 é é',NULL,NULL,NULL)`, [S.tx, S.one, id(100), S.branch, id(700), S.manual], source);
    for (const [n, state, amount, owner] of [[600, 'pending', PENDING, S.one], [601, 'pending', '0.87654321098765432109876543211', S.one],
      [602, 'pending', '7.00000000000000000000000000001', S.two], [603, 'approved', '2.5', S.one], [604, 'rejected', '4.125', S.one], [605, 'cancelled', '5', S.one]])
      await change('public.withdrawals', `INSERT INTO public.withdrawals(id,user_id,amount,status,audit_remark,audited_by,audited_at,created_at,last_operation_id)
        VALUES($1,$2,$3::numeric,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9)`, [id(n), owner, amount, state, n % 2 ? '原文 é 𠮷' : null,
        state === 'pending' ? null : n % 2 ? NEW.root : S.branch, n % 2 ? '2023-02-03T04:05:06.654321Z' : null,
        n % 2 ? null : '2023-02-03T04:05:06.123456Z', n % 2 ? null : id(800 + n)], source);
    await change('public.wallets', `UPDATE public.wallets SET available_balance=CASE user_id WHEN $1 THEN $2::numeric ELSE 40 END,
      frozen_balance=CASE user_id WHEN $1 THEN 4 ELSE 7.00000000000000000000000000001 END,
      created_at='2021-01-02T03:04:05.123456Z',updated_at=NULL`, [S.one, AVAILABLE], source);
    await change('public.wallet_balance_baselines', 'DELETE FROM public.wallet_balance_baselines', [], source);
    await change('public.wallet_ledger_entries', 'DELETE FROM public.wallet_ledger_entries', [], source);
    await source.query(`INSERT INTO public.wallet_ledger_entries(id,user_id,operation_id,source_type,source_id,event_type,available_delta,frozen_delta,income_delta,created_at) VALUES
      (1,$1,$3,'wallet_transaction',$4,'before',100,0,30,'2020-01-02T03:04:05.123456Z'),
      (9007199254740993,$1,$5,'wallet_transaction',$4,'at',0,0,0,'2021-01-02T03:04:05.123456Z'),
      (9007199254740994,$1,$6,'wallet_transaction',$4,'after',5.12345678901234567890123456789,0,2.12345678901234567890123456789,'2022-01-02T03:04:05.123456Z'),
      (3,$2,$7,'withdrawal',$8,'historical-withdrawal',0,0,0,'2020-01-02T03:04:05.123456Z'),
      (4,$2,$9,'wallet_transaction',$10,'deleted-historical-event',0,0,0,'2020-01-02T03:04:05.654321Z')`,
    [S.one, S.two, id(710), S.tx, id(711), id(712), id(713), S.pendingTwo, id(714), id(777)]);
    await source.query(`INSERT INTO public.wallet_balance_baselines(user_id,available_balance,frozen_balance,total_income,last_ledger_id,established_at)
      VALUES($1,100,0,30,9007199254740993,'2022-01-02T03:04:05.123456Z')`, [S.one]);
    await source.query(`INSERT INTO public.wallet_reconciliation_audit(id,user_id,available_before,available_after,frozen_before,frozen_after,income_before,income_after,pending_amount,ledger_total,reason,repaired_at)
      VALUES(9007199254740999,$1,103,$2::numeric,2,4,31,32.12345678901234567890123456789,4,105.12345678901234567890123456789,'來源對賬原因 é 𠮷','2023-03-04T05:06:07.123456Z')`, [S.one, AVAILABLE]);
  }, source, true);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active) SELECT $1,'mapped-activity-other-root',password_hash,'super_admin',true FROM public.admins WHERE id=$2`, [id(300), NEW.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [id(300)]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  other = await adminLogin(db, 'mapped-activity-other-root', PASSWORDS.root); pkg = randomUUID();
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';
    export {createEmployeeMappedActivitySession} from './src/lib/employeeTransfer/employeeMappedActivity.ts';
    export {setHarness} from 'mapped-activity-db:state';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', plugins: [{ name: 'local-mapped-activity-sql', setup(builder) {
      builder.onResolve({ filter: /^(?:mapped-activity-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'mapped-activity-db' }));
      builder.onLoad({ filter: /.*/, namespace: 'mapped-activity-db' }, ({ path }) => ({ contents: path === 'mapped-activity-db:state'
        ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
        : path === '../auth' ? 'import{current}from"mapped-activity-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
          : 'import{current}from"mapped-activity-db:state";export const supabase={rpc:(name,args)=>current().rpc(name,args)};' }));
    } }] });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await transaction(async () => { await seedActivity(); shared = await capture('shared'); dispatch = await capture('dispatch'); identity = await capture('identity'); finance = await capture('finance'); activity = await capture('activity'); expected = await expectedActivity(); }, source, true);
  assert.deepEqual(finance.catalog.identity_catalog, identity.catalog); assert.deepEqual(identity.catalog.tables.map(t => t.rows), [2, 2, 4]);
  await transaction(async () => {
    const prepared = await prepare('shared', shared); sharedTask = prepared.job;
    const r = await rpc('employee_import_shared_replace_apply', { ...auth(sharedTask), p_plan_hash: prepared.plan.plan_hash });
    assert.equal(r.success, true); assert.equal(r.admin_map[S.branch], NEW.branch); assert.equal(r.admin_map[NEW.root], NEW.root);
    await rpc('employee_transfer_cancel', auth(sharedTask));
  }, db, true);
  sharedDump = await db.dumpDataDir('none');
  await transaction(() => configure(dispatch), db, true);
  await transaction(async () => { await restoreValid(); await restoreIdentities(); await restoreDependencies(); await noLegacy(); }, db, true);
  readyTask = task; preFinanceDump = await db.dumpDataDir('none');
  await transaction(() => restoreFinance(), db, true);
  await transaction(() => noLegacy());
  readyDump = await db.dumpDataDir('none');
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });

test('SQL52 strict real migration replay retains exactly twelve historical failures and executes SQL52', () => {
  assert.equal(replay.files.length, 579); assert.equal(replay.files.at(-1), MIGRATION);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  assert.equal(replay.validation.freshDatabaseVerified, false);
});

test('SQL52 exact seven RPC signatures, browser-only grants, private helpers and genuinely STABLE reads', () => transaction(async () => {
  const specs = { bind: [['p_catalog', 'jsonb']], stage: [['p_table_key', 'text'], ['p_chunk_no', 'integer'], ['p_ndjson', 'text']],
    plan: [], begin: [['p_plan_hash', 'text']], apply: [['p_source_id', 'uuid'], ['p_plan_hash', 'text']], status: [['p_source_id', 'uuid']], verify: [] };
  const fns = await rows(db, `SELECT proname,provolatile,prosecdef,proconfig,proargnames,pronargdefaults,
    (SELECT array_agg(format_type(t,NULL) ORDER BY n) FROM unnest(proargtypes::oid[]) WITH ORDINALITY a(t,n)) AS types,
    oid::regprocedure::text AS signature,EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'employee_import_mapped_activity_%' ORDER BY proname`);
  assert.deepEqual(fns.map(f => f.proname).sort(), OPERATIONS.map(k => PREFIX + k).sort());
  for (const fn of fns) {
    const op = fn.proname.slice(PREFIX.length), spec = specs[op];
    assert.equal(fn.provolatile, ['plan', 'status'].includes(op) ? 's' : 'v'); assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp')); assert.equal(fn.public_execute, false); assert.equal(fn.pronargdefaults, 0);
    assert.deepEqual(fn.proargnames, ['p_admin_session_token', 'p_job_token', ...spec.map(r => r[0])]);
    assert.deepEqual(fn.types, ['uuid', 'uuid', ...spec.map(r => r[1])]);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), role !== 'service_role');
    await assert.rejects(call(op, argsFor(op, { plan_hash: '0'.repeat(64) }), 'service_role'), /permission denied/);
  }
  const helpers = ['context', 'input', 'source', 'parse', 'catalog', 'saved', 'expected', 'check_written', 'phase', 'plan', 'conflicts', 'check_counts'];
  const privateFns = await rows(db, `SELECT proname,oid::regprocedure::text AS signature FROM pg_proc
    WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_mapped_activity_%'`);
  assert.deepEqual(privateFns.map(f => f.proname).sort(), helpers.map(k => 'employee_transfer_mapped_activity_' + k).sort());
  for (const fn of privateFns) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), false);
  await assert.rejects(call('status'), { code: '42883' });
}));

for (const role of ['anon', 'authenticated']) test(`SQL52 ${role}: golden mapped three-table restore, full-field independent comparison and zero signals or money changes`, () => transaction(async () => {
  const initial = await business(), modes = await triggers(), previousSummary = await summary(), sourceBefore = await snapshot(source);
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  const p = await stage(activity, role); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.totals, { employee_login_history: 7, work_sessions: 6, work_stop_markers: 2 });
  assert.equal(p.employees, 2); assert.equal(p.running_work_sessions, 2); assert.notEqual(p.site_id, p.source_site_id);
  const initialStatus = await status(null, {}, role); common(initialStatus, p); assert.equal(initialStatus.started, false);
  const begun = await begin(p, {}, role); common(begun, p); assert.equal(begun.started, true); assert.equal(begun.completed_employees, 0);
  await assert.rejects(verify({}, role));
  for (const [n, sourceId] of EMPLOYEES.entries()) {
    assert.equal((await status(sourceId, {}, role)).employee.applied, false);
    const r = await apply(p, sourceId, {}, role); common(r, p); assert.equal(r.completed_employees, n + 1); assert.equal(r.employee.applied, true);
    assert.deepEqual(await status(sourceId, {}, role), r); assert.deepEqual(await plan({}, role), p);
    const frozen = await snapshot(); assert.deepEqual(await apply(p, sourceId, {}, role), r); assert.deepEqual(await snapshot(), frozen);
    assert.deepEqual(await triggers(), modes); await noLegacy();
  }
  const result = await verify({}, role); common(result, p); assert.equal(result.verified, true);
  const frozen = await snapshot(); assert.deepEqual(await verify({}, role), result); assert.deepEqual(await begin(p, {}, role), result);
  assert.deepEqual(await status(null, {}, role), result); assert.deepEqual(await snapshot(), frozen);
  await assertActivity(); await noLegacy();
  const changed = (await business()).filter((r, i) => JSON.stringify(r) !== JSON.stringify(initial[i])).map(r => r.name);
  assert.deepEqual(changed.sort(), Object.values(RELATIONS).sort());
  // The all-table digest comparison includes users, wallets/six financial tables, automation
  // queues, reconciliation queues, realtime events, sessions, financial_operations and valid counters.
  assert.deepEqual(await summary(), previousSummary); assert.deepEqual(await snapshot(source), sourceBefore);
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
  assert.deepEqual(await triggers(), modes);
}));

test('SQL52 plan/status are real READ ONLY before and after first activity employee, no heartbeat changes', () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); }, db, true);
  await transaction(async () => {
    await db.exec('SET TRANSACTION READ ONLY'); const frozen = await snapshot();
    common(await plan(), p); common(await status(), p); assert.deepEqual(await snapshot(), frozen);
  });
  await transaction(async () => { await begin(p); await apply(p, S.two); }, db, true);
  await transaction(async () => {
    await db.exec('SET TRANSACTION READ ONLY'); const applied = await snapshot();
    common(await plan(), p); const s = await status(); common(s, p); assert.equal(s.completed_employees, 1);
    for (const sourceId of EMPLOYEES) assert.equal((await status(sourceId)).employee.applied, sourceId === S.two);
    assert.deepEqual(await snapshot(), applied);
  });
}));

test('SQL52 device precision, arrays/scalars and SQL NULL versus JSON null survive exact source bytes', () => transaction(async () => {
  assert.ok(activity.texts.employee_login_history.includes(PRECISE));
  const p = await stage(); await finish(p); await assertActivity();
  assert.equal(await scalar(db, 'SELECT device_info IS NULL FROM public.employee_login_history WHERE id=$1', [id(1002)]), true);
  assert.equal(await scalar(db, "SELECT device_info IS NOT NULL AND device_info='null'::jsonb FROM public.employee_login_history WHERE id=$1", [id(1003)]), true);
  assert.equal(await scalar(db, "SELECT device_info#>>'{children,0,precise}' FROM public.employee_login_history WHERE id=$1", [id(1001)]), PRECISE);
  assert.equal(await scalar(db, 'SELECT device_info::text FROM public.employee_login_history WHERE id=$1', [id(1004)]), PRECISE);
  assert.equal(await scalar(db, 'SELECT created_at IS NULL FROM public.employee_login_history WHERE id=$1', [id(1002)]), true);
  assert.equal(await scalar(db, "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') FROM public.employee_login_history WHERE id=$1", [id(1001)]), '2023-02-03 04:05:06.654321');
}));

test('SQL52 open sessions use strict last heartbeat without grace; closed NULL/duration unchanged', () => transaction(async () => {
  const p = await stage(); await finish(p); await assertActivity();
  assert.equal(await scalar(db, 'SELECT end_time=last_heartbeat_at AND duration_minutes=2 FROM public.work_sessions WHERE id=$1', [id(2001)]), true);
  assert.equal(await scalar(db, 'SELECT duration_minutes=777 AND end_time=last_heartbeat_at FROM public.work_sessions WHERE id=$1', [id(2004)]), true);
  assert.equal(await scalar(db, 'SELECT duration_minutes IS NULL AND last_heartbeat_at IS NULL AND created_at IS NULL FROM public.work_sessions WHERE id=$1', [id(2005)]), true);
  assert.equal(await scalar(db, 'SELECT end_time=last_heartbeat_at AND duration_minutes=0 FROM public.work_sessions WHERE id=$1', [id(2006)]), true);
  assert.equal(await scalar(db, 'SELECT count(*)::integer FROM public.work_sessions WHERE end_time IS NULL'), 0);
}));

test('SQL52 no-heartbeat and early-heartbeat source sessions close at start without weakening the one-active-session unique index', async () => {
  for (const n of [2, 3]) await sourceVariant(async () => {
    await change('public.work_sessions', 'UPDATE public.work_sessions SET end_time=start_time,duration_minutes=0 WHERE id=$1', [id(2001)], source);
    await change('public.work_sessions', 'UPDATE public.work_sessions SET end_time=NULL,duration_minutes=999 WHERE id=$1', [id(2000 + n)], source);
  }, async input => {
    const p = await stage(); assert.equal(p.running_work_sessions, 2); await finish(p); await assertActivity(input.expected);
    assert.equal(await scalar(db, 'SELECT end_time=start_time AND duration_minutes=0 FROM public.work_sessions WHERE id=$1', [id(2000 + n)]), true);
  });
});

test('SQL52 running duration beyond int32 is a blocked real-source plan, never truncation or repair', () => sourceVariant(() => change('public.work_sessions',
  "UPDATE public.work_sessions SET last_heartbeat_at='9000-01-01T00:00:00.654321Z' WHERE id=$1", [id(2001)], source), async () => {
    const before = await business(), p = await stage(); assert.equal(p.can_begin, false); assert.ok(p.conflicts.includes('work_duration_out_of_range'));
    await assert.rejects(begin(p)); assert.deepEqual(await business(), before); await noLegacy();
  }, false));

test('SQL52 historical employee_id is an employee number, session hash is not rehashed, private marker moves to new UUID', () => transaction(async () => {
  const p = await stage(); await finish(p);
  const one = bindings[S.one].target_id, two = bindings[S.two].target_id;
  assert.equal(await scalar(db, 'SELECT bool_and(employee_id=$1 AND employee_id<>user_id::text) FROM public.employee_login_history', ['歷史員工號-0042']), true);
  const hashed = 'history-' + sha(`${activity.catalog.site_id}:${S.one}:source-live-session-never-import`);
  assert.equal(await scalar(db, 'SELECT session_id FROM public.employee_login_history WHERE id=$1', [id(1001)]), hashed);
  assert.equal(await scalar(db, 'SELECT session_id FROM public.employee_login_history WHERE id=$1', [id(1003)]), hashed);
  assert.notEqual(await scalar(db, 'SELECT session_id FROM public.employee_login_history WHERE id=$1', [id(1007)]), hashed);
  assert.equal(await scalar(db, 'SELECT session_id IS NULL FROM public.employee_login_history WHERE id=$1', [id(1002)]), true);
  assert.deepEqual(await rows(db, 'SELECT user_id::text FROM private.employee_work_stop_markers ORDER BY user_id'), [{ user_id: one }, { user_id: two }].sort((a, b) => a.user_id.localeCompare(b.user_id)));
  await assertActivity();
}));

test('SQL52 catalog/chunks repeat only before begin; frozen mismatches and further bind/stage after begin reject', () => transaction(async () => {
  const p = await stage(); const frozen = await snapshot(); await bind();
  for (const key of ACTIVITY) for (const [no, text] of chunks(activity.texts[key], 2).entries()) await stageChunk(key, no, text);
  assert.deepEqual(await snapshot(), frozen);
  await assert.rejects(stageChunk('employee_login_history', 0, chunks(activity.texts.employee_login_history, 2)[0].replace('歷史名稱', 'changed')));
  await begin(p); const begun = await snapshot(); await assert.rejects(bind());
  await assert.rejects(stageChunk('employee_login_history', 0, chunks(activity.texts.employee_login_history, 2)[0]));
  assert.deepEqual(await snapshot(), begun); await finish(p);
}));

test('SQL52 exact plan hashes, unknown/NULL/target source UUIDs and premature apply/verify fail without writes', () => transaction(async () => {
  const p = await stage(); const frozen = await snapshot(); await assert.rejects(apply(p)); await assert.rejects(verify());
  for (const hash of [null, '', '0'.repeat(63), 'A'.repeat(64), '0'.repeat(64)]) await assert.rejects(begin(p, { p_plan_hash: hash }));
  assert.deepEqual(await snapshot(), frozen); await begin(p);
  for (const sourceId of [null, randomUUID(), bindings[S.one].target_id]) { await assert.rejects(apply(p, sourceId)); if (sourceId) await assert.rejects(status(sourceId)); }
  for (const hash of [null, '', '0'.repeat(64)]) await assert.rejects(apply(p, S.one, { p_plan_hash: hash }));
  await apply(p); await assert.rejects(verify()); await apply(p, S.two); assert.equal((await verify()).verified, true);
}));

test('SQL52 catalog source/package/schema binding immutable; no caller-supplied identity or backup proof', () => transaction(async () => {
  for (const patch of [{ package_id: randomUUID() }, { site_id: randomUUID() }, { unexpected: true }, { full_site_complete: true }])
    await assert.rejects(bind({ catalog: { ...activity.catalog, ...patch } }));
  await bind(); const frozen = await snapshot();
  await assert.rejects(bind({ catalog: { ...activity.catalog, tables: activity.catalog.tables.map((t, n) => n ? t : { ...t, rows: t.rows + 1 }) } }));
  for (const op of OPERATIONS) {
    const names = await scalar(db, 'SELECT proargnames FROM pg_proc WHERE pronamespace=\'public\'::regnamespace AND proname=$1', [PREFIX + op]);
    assert.ok(!names.some(n => /target_id|identity_map|backup_verified|rows/.test(n)));
  }
  assert.deepEqual(await snapshot(), frozen);
}));

test('SQL52 explicit complete staging required, missing/reordered/duplicate chunks and unsupported keys refused', () => transaction(async () => {
  await bind(); await assert.rejects(plan()); await assert.rejects(status());
  for (const key of [null, 'orders', 'private.employee_work_stop_markers', 'work_sessions;DROP TABLE users']) await assert.rejects(stageChunk(key, 0, ''));
  for (const no of [null, -1, 999]) await assert.rejects(stageChunk('employee_login_history', no, lines(activity.texts.employee_login_history)[0]));
  await stageChunk('employee_login_history', 0, lines(activity.texts.employee_login_history)[0]);
  await assert.rejects(stageChunk('employee_login_history', 1, lines(activity.texts.employee_login_history)[0]));
  await assert.rejects(plan()); await noLegacy();
}));

test('SQL52 stage rescans duplicate/missing/extra fields, newline, SQL-null projection and session hash format', () => transaction(async () => {
  await bind(); const raw = lines(activity.texts.employee_login_history)[0], frozen = await snapshot();
  for (const text of [raw.replace('{', '{"user_id":"' + S.one + '",'), raw.replace('{', '{"unreviewed":1,'), raw.slice(0, -1),
    raw.replace(/"device_info_is_sql_null": false/, '"device_info_is_sql_null": true'), raw.replace(/history-[0-9a-f]{64}/, 'live-session'),
    raw.replace(/"employee_id": "[^"]*", /, '')]) await assert.rejects(stageChunk('employee_login_history', 0, text));
  assert.deepEqual(await snapshot(), frozen);
}));

test('SQL52 recursive device secret check rejects normalized nested secret keys from real source exports', async () => {
  for (const key of ['access_token', 'Client-Secret', 'session/id']) await sourceVariant(() => change('public.employee_login_history',
    'UPDATE public.employee_login_history SET device_info=jsonb_build_object(\'children\',jsonb_build_array(jsonb_build_object($2::text,\'local-secret\'))) WHERE id=$1', [id(1001), key], source), async () => {
      await bind(); const frozen = await snapshot(); await assert.rejects(stageChunk('employee_login_history', 0, lines(activity.texts.employee_login_history)[0]));
      assert.deepEqual(await snapshot(), frozen);
    });
});

for (const [label, extras] of [
  ['invalid sessions', () => [null, randomUUID(), sourceSession].map(v => ({ p_admin_session_token: v }))],
  ['secondary/emergency/foreign-root roles', () => [branch, emergency, other].map(v => ({ p_admin_session_token: v }))],
  ['invalid and foreign tasks', () => [null, randomUUID(), sharedTask.job_token].map(v => ({ p_job_token: v }))],
]) test(`SQL52 denies ${label} on every RPC and both browser roles`, () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two); for (const extra of extras()) await denyAll(p, extra);
}));

test('SQL52 expired/revoked sessions and inactive/demoted task owners cannot continue', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [relation, sql, params] of [
    ['public.admin_financial_sessions', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", [session]],
    ['public.admin_financial_sessions', 'UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)', [session]],
    ['public.admins', 'UPDATE public.admins SET is_active=false WHERE id=$1', [NEW.root]],
    ['public.admins', "UPDATE public.admins SET role='secondary_admin' WHERE id=$1", [NEW.root]],
  ]) await isolated(async () => { await change(relation, sql, params); await denyAll(p); });
}));

test('SQL52 expired/failed task, missing maintenance, missing independent seal and wrong protocol remain blocked', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const sql of ["UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1",
    "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1",
    "UPDATE private.employee_transfer_jobs SET status='failed' WHERE id=$1",
    "UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,'{import_protocol}','\"shared-import-v1\"') WHERE id=$1",
    'DELETE FROM private.employee_transfer_maintenance WHERE job_id=$1',
    'UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1'])
    await isolated(async () => { await db.query(sql, [task.job_id]); await denyAll(p); });
}));

test('SQL52 real cancellation retains written activity, funds and dirty maintenance but revokes continuation', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  const before = await business(), maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  assert.equal((await rpc('employee_transfer_cancel', auth())).success, true); assert.deepEqual(await business(), before);
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance); await denyAll(p);
}));

for (const missing of ['not begun', 'one employee only', 'all applied but unverified']) test(`SQL52 requires actual fully verified SQL51 finance: ${missing}`, () => withClone(preFinanceDump, readyTask, () => transaction(async () => {
  if (missing !== 'not begun') await restoreFinance({ applied: missing === 'one employee only' ? [S.one] : EMPLOYEES, verified: false });
  await denyAll({ plan_hash: '0'.repeat(64) }); await noLegacy();
})));

for (const [label, relation, sql, params] of [
  ['account remark', 'users', "UPDATE public.users SET remarks='same-count account drift' WHERE id=$1", () => [bindings[S.one].target_id]],
  ['credential password', 'financial_employee_credentials', "UPDATE public.financial_employee_credentials SET password_hash='local-negative' WHERE user_id=$1", () => [bindings[S.two].target_id]],
  ['order precision', 'orders', 'UPDATE public.orders SET commission_amount=commission_amount+0.00000000000000000000000000001 WHERE id=$1', () => [id(100)]],
  ['member microsecond', 'dispatch_group_members', "UPDATE public.dispatch_group_members SET assigned_at=assigned_at+interval '1 microsecond' WHERE id=$1", () => [S.memberOne]],
  ['wallet precision', 'wallets', 'UPDATE public.wallets SET available_balance=available_balance+0.00000000000000000000000000001 WHERE user_id=$1', () => [bindings[S.one].target_id]],
  ['pending funds', 'withdrawals', 'UPDATE public.withdrawals SET amount=amount+0.00000000000000000000000000001 WHERE id=$1', () => [S.pending]],
  ['written login device null kind', 'employee_login_history', "UPDATE public.employee_login_history SET device_info='null'::jsonb WHERE id=$1", () => [id(1002)]],
  ['written closed heartbeat', 'work_sessions', "UPDATE public.work_sessions SET last_heartbeat_at=last_heartbeat_at+interval '1 microsecond' WHERE id=$1", () => [id(2001)]],
  ['written private marker', 'employee_work_stop_markers', "UPDATE private.employee_work_stop_markers SET stopped_at=stopped_at+interval '1 microsecond' WHERE user_id=$1", () => [bindings[S.one].target_id]],
]) test(`SQL52 stage-aware guard detects ${label} drift even after activity verification`, () => transaction(async () => {
  const p = await stage(); await finish(p); const beforeCounts = (await business()).map(r => [r.name, r.n]);
  await change((relation === 'employee_work_stop_markers' ? 'private.' : 'public.') + relation, sql, params());
  assert.deepEqual((await business()).map(r => [r.name, r.n]), beforeCounts);
  await denyAll(p);
}));

test('SQL52 SQL48/49/50/51 state drift and legacy summaries cannot fake prerequisites', () => transaction(async () => {
  const p = await stage(); await finish(p);
  for (const [key, employee, path, value] of [
    ['identity-reservation-v1', S.two, ['target_id'], S.one], ['mapped-identity-v1', S.two, ['verified'], false],
    ['mapped-dependencies-v1', ZERO, ['identity_map'], {}], ['mapped-finance-v1', ZERO, ['verified'], false],
    ['mapped-finance-done-v1', S.two, ['counts', 'wallets'], 0],
  ]) await isolated(async () => {
    const changed = await rows(db, 'UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$4::text[],$5::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key=$3 RETURNING employee_id', [task.job_id, employee, key, path, JSON.stringify(value)]);
    assert.equal(changed.length, 1); await denyAll(p);
  });
  for (const key of ['activity_restore', 'finance_restore', 'verified_identity_map']) await isolated(async () => {
    await db.query("UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,$2::text[],'{}'::jsonb) WHERE id=$1", [task.job_id, [key]]); await denyAll(p);
  });
}));

for (const key of ACTIVITY) test(`SQL52 ${key} raw NDJSON and parsed body cannot diverge after first employee commit`, () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const expression of ["jsonb_set(payload,'{ndjson}',to_jsonb((payload->>'ndjson')||E'\\n'))", "jsonb_set(payload,'{rows,0,user_id}',to_jsonb('" + S.unrelated + "'::text))"])
    await isolated(async () => {
      const changed = await rows(db, `UPDATE private.employee_transfer_staging SET payload=${expression} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0 RETURNING employee_id`, [task.job_id, 'mapped-activity-in:' + key]);
      assert.equal(changed.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
    });
}));

test('SQL52 staging byte/hash/last-id and frozen catalog corruption rejected, not just parsed row count', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [key, expression] of [
    ['mapped-activity-in:employee_login_history', "jsonb_set(payload,'{bytes}',to_jsonb((payload->>'bytes')::integer+1))"],
    ['mapped-activity-in:work_sessions', "jsonb_set(payload,'{row_hashes}',to_jsonb(repeat('0',length(payload->>'row_hashes'))))"],
    ['mapped-activity-in:work_stop_markers', "jsonb_set(payload,'{last_id}','null'::jsonb)"],
    ['mapped-activity-catalog-v1', "jsonb_set(payload,'{package_id}',to_jsonb('" + S.unrelated + "'::text))"],
  ]) await isolated(async () => {
    const changed = await rows(db, `UPDATE private.employee_transfer_staging SET payload=${expression} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0 RETURNING employee_id`, [task.job_id, key]);
    assert.equal(changed.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
  });
}));

test('SQL52 saved identity/admin maps, progress and verified types rechecked against actual rows', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [path, value] of [[['identity_map'], {}], [['admin_map'], {}], [['completed_employees'], 0], [['completed_employees'], '1'], [['verified'], true], [['verified'], 'false']])
    await isolated(async () => {
      await db.query('UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND table_key=$2', [task.job_id, STATE, path, JSON.stringify(value)]);
      await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
    });
}));

test('SQL52 saved full plan fields/hash/running count/gates cannot be tampered independently', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [path, value] of [[['plan', 'plan_hash'], '0'.repeat(64)], [['plan', 'scope'], 'forged'], [['plan', 'running_work_sessions'], 0],
    [['plan', 'totals', 'work_sessions'], 0], [['plan', 'can_restore'], true], [['plan', 'can_begin'], false]]) await isolated(async () => {
    await db.query('UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND table_key=$2', [task.job_id, STATE, path, JSON.stringify(value)]);
    await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
  });
}));

test('SQL52 completion source/target/hash/counts binding cannot substitute another employee', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [path, value] of [[['source_id'], S.one], [['target_id'], S.two], [['plan_hash'], '0'.repeat(64)], [['counts', 'work_sessions'], 0], [['counts', 'work_sessions'], '1']])
    await isolated(async () => {
      const changed = await rows(db, 'UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$4::text[],$5::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key=$3 RETURNING employee_id', [task.job_id, S.two, DONE, path, JSON.stringify(value)]);
      assert.equal(changed.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
    });
}));

test('SQL52 namespace employee/chunk/row_count and extra state fields never silently ignored', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [key, assignment] of [['mapped-activity-catalog-v1', `employee_id='${S.unrelated}'`], [STATE, 'chunk_no=999'], [DONE, 'row_count=2'],
    ['mapped-activity-in:work_sessions', 'chunk_no=999'], [STATE, "payload=payload||'{\"unexpected\":true}'::jsonb"]]) await isolated(async () => {
    const changed = await rows(db, `UPDATE private.employee_transfer_staging SET ${assignment} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0 RETURNING employee_id`, [task.job_id, key]);
    assert.equal(changed.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
  });
}));

for (const [label, key, sql, params, reason] of [
  ['login residual', 'employee_login_history', "INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type) VALUES($1,$2,'residual','OLD-42','login')", () => [id(9999), bindings[S.two].target_id], 'activity_target_not_empty'],
  ['work residual', 'work_sessions', "INSERT INTO public.work_sessions(id,user_id,start_time,end_time) VALUES($1,$2,'2022-01-01','2022-01-02')", () => [id(9999), bindings[S.two].target_id], 'activity_target_not_empty'],
  ['marker residual', 'work_stop_markers', "INSERT INTO private.employee_work_stop_markers(user_id,stopped_at) VALUES($1,'2022-01-01')", () => [bindings[S.two].target_id], 'activity_target_not_empty'],
  ['login UUID collision', 'employee_login_history', "INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type) VALUES($1,$2,'unrelated','OTHER-42','login')", () => [id(1001), S.unrelated], 'activity_uuid_collision'],
  ['work UUID collision', 'work_sessions', "INSERT INTO public.work_sessions(id,user_id,start_time,end_time) VALUES($1,$2,'2022-01-01','2022-01-02')", () => [id(2001), S.unrelated], 'activity_uuid_collision'],
]) test(`SQL52 ${label} blocks before begin and after frozen plan without overwrite`, () => transaction(async () => {
  await unrelatedEmployee(); const p = await stage();
  await isolated(async () => {
    await change(RELATIONS[key], sql, params()); const frozen = await business(), blocked = await plan(); common(blocked);
    assert.equal(blocked.can_begin, false); assert.ok(blocked.conflicts.includes(reason)); await assert.rejects(begin(blocked));
    assert.deepEqual(await business(), frozen);
  });
  await begin(p); await change(RELATIONS[key], sql, params()); const frozen = await snapshot(); await assert.rejects(apply(p));
  assert.deepEqual(await snapshot(), frozen);
}));

for (const key of ACTIVITY) test(`SQL52 unknown ${key} trigger rejected without normalizing modes or mutating any table`, () => transaction(async () => {
  const p = await stage(); await begin(p);
  await db.exec(`CREATE TRIGGER aa_mapped_activity_unknown BEFORE INSERT ON ${RELATIONS[key]} FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()`);
  await denyAll(p);
}));

for (const [label, sql] of [
  ['disabled/replica side effects', ['ALTER TABLE public.employee_login_history DISABLE TRIGGER employee_login_history_emit_event', 'ALTER TABLE public.work_sessions ENABLE REPLICA TRIGGER trigger_validate_work_session']],
  ['changed function/missing ALWAYS guard', ['ALTER FUNCTION public.emit_employee_login_history_event() SECURITY INVOKER', 'ALTER TABLE private.employee_work_stop_markers DISABLE TRIGGER zz_employee_transfer_maintenance']],
]) test(`SQL52 ${label} refuse before writes and leave modes untouched`, () => transaction(async () => {
  const p = await stage(); await begin(p); for (const command of sql) await isolated(async () => { await db.exec(command); await denyAll(p); });
}));

for (const fault of ['constraint', 'audit']) test(`SQL52 late ${fault} failure rolls back current employee only; previously COMMITTED employee stays intact`, () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); await begin(p); await apply(p, S.two); }, db, true);
  await transaction(async () => {
    if (fault === 'constraint') await db.exec(`ALTER TABLE private.employee_work_stop_markers ADD CONSTRAINT mapped_activity_late CHECK(user_id<>'${bindings[S.one].target_id}'::uuid) NOT VALID`);
    else await db.exec(`CREATE FUNCTION public.mapped_activity_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'mapped activity final audit failed'; END $$;
      CREATE TRIGGER mapped_activity_late_failure BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.mapped_activity_late_failure()`);
    const frozen = await snapshot(), modes = await triggers(); await assert.rejects(apply(p));
    assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
    assert.equal((await status(S.two)).employee.applied, true); assert.equal((await status(S.one)).employee.applied, false);
    for (const key of ACTIVITY) assert.equal(await scalar(db, `SELECT count(*)::integer FROM ${RELATIONS[key]} WHERE user_id=$1`, [bindings[S.one].target_id]), 0);
    if (fault === 'constraint') await db.exec('ALTER TABLE private.employee_work_stop_markers DROP CONSTRAINT mapped_activity_late');
    else await db.exec('DROP TRIGGER mapped_activity_late_failure ON private.employee_transfer_events; DROP FUNCTION public.mapped_activity_late_failure()');
    await apply(p); assert.equal((await verify()).verified, true); await assertActivity(); await noLegacy();
  }, db, true);
}));

test('SQL52 actual COMMIT then lost apply response resumes from independent database dump without duplicate rows', () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); await begin(p); }, db, true);
  await assert.rejects((async () => { await transaction(() => apply(p), db, true); throw new Error('local response lost AFTER COMMIT'); })(), /AFTER COMMIT/);
  const committed = await db.dumpDataDir('none');
  await withClone(committed, readyTask, () => transaction(async () => {
    const r = await status(S.one); common(r, p); assert.equal(r.completed_employees, 1); assert.equal(r.employee.applied, true);
    assert.equal((await status(S.two)).employee.applied, false); const frozen = await snapshot();
    assert.deepEqual(await apply(p), r); assert.deepEqual(await snapshot(), frozen);
    await apply(p, S.two); assert.equal((await verify()).verified, true); await assertActivity(); await noLegacy();
  }, db, true));
}));

test('SQL52 real activity client to anon SQL: lost apply response reconciles SAME-source status, never automatic retry', () => withClone(readyDump, readyTask, async () => {
  const calls = []; let drop = true;
  modules.setHarness({ token: session, rpc(name, args) {
    const query = transaction(async () => { calls.push({ name, args }); return on(db, name, args); }, db, true).then(data => {
      if (drop && name === PREFIX + 'apply') { drop = false; throw new Error('response lost AFTER COMMIT'); }
      return { data, error: null };
    }); query.abortSignal = () => query; return query;
  } });
  const client = modules.createEmployeeMappedActivitySession(task.job_token); await client.bind(activity.catalog);
  for (const key of ACTIVITY) for (const [no, text] of chunks(activity.texts[key], 2).entries()) await client.stage(key, no, text);
  const p = await client.plan(); common(p); await client.begin(p);
  await assert.rejects(client.apply(S.one), /unconfirmed/); const n = calls.length;
  await assert.rejects(client.apply(S.two), /unconfirmed/); assert.equal(calls.length, n);
  await client.plan(); await client.status(S.two); const afterWrong = calls.length;
  await assert.rejects(client.apply(S.two), /unconfirmed/); assert.equal(calls.length, afterWrong);
  const s = await client.status(S.one); assert.equal(s.employee.applied, true); assert.equal(s.completed_employees, 1);
  assert.equal((await client.apply(S.two)).employee.applied, true); assert.equal((await client.verify()).verified, true);
  assert.equal(drop, false); assert.equal(calls.filter(c => c.name === PREFIX + 'apply').length, 2);
  assert.equal(calls.filter(c => c.name === PREFIX + 'begin').length, 1); assert.equal(calls.filter(c => c.name === PREFIX + 'verify').length, 1);
  for (const c of calls) assert.equal(c.args.p_job_token, task.job_token);
  await transaction(async () => { await assertActivity(); await noLegacy(); });
}));

test('SQL52 non-UTC caller timezone cannot alter microsecond comparisons or closed work semantics', () => transaction(async () => {
  const p = await stage(); await db.exec("SET LOCAL TimeZone='America/New_York'"); assert.deepEqual(await plan(), p); await finish(p);
  assert.equal(await scalar(db, "SELECT current_setting('TimeZone')"), 'America/New_York');
  await db.exec("SET LOCAL TimeZone='UTC'"); await assertActivity();
}));

test('SQL52 two employees with genuinely empty histories require all three explicit empty chunks', () => sourceVariant(async () => {
  for (const key of ACTIVITY) await change(RELATIONS[key], `DELETE FROM ${RELATIONS[key]}`, [], source);
}, async input => {
  await bind(); await stageChunk('employee_login_history', 0, ''); await assert.rejects(plan());
  await stageChunk('work_sessions', 0, ''); await stageChunk('work_stop_markers', 0, '');
  const p = await plan(); common(p); assert.equal(p.can_begin, true); assert.equal(p.running_work_sessions, 0);
  assert.deepEqual(p.totals, Object.fromEntries(ACTIVITY.map(k => [k, 0]))); await finish(p); await assertActivity(input.expected);
}));

test('SQL52 zero employees uses real source export, independent backups and actual SQL48–51 empty prerequisites', async () => {
  const empty = await transaction(async () => {
    for (const key of ACTIVITY) await change(RELATIONS[key], `DELETE FROM ${RELATIONS[key]}`, [], source);
    for (const key of [...FINANCE].reverse().concat(['used_order_data', 'dispatch_group_members', 'orders', 'financial_employee_credentials', 'users']))
      await change('public.' + key, `DELETE FROM public.${key}`, [], source);
    return { dispatch: await capture('dispatch'), identity: await capture('identity'), finance: await capture('finance'), activity: await capture('activity') };
  }, source);
  const previous = { finance, activity }; finance = empty.finance; activity = empty.activity;
  try { await withClone(sharedDump, null, () => transaction(async () => {
    await configure(empty.dispatch); await restoreValid(); await restoreIdentities(empty.identity, []); await restoreDependencies(); await restoreFinance({ applied: [] });
    const p = await stage(); common(p); assert.equal(p.can_begin, true); assert.equal(p.employees, 0); assert.equal(p.running_work_sessions, 0);
    assert.deepEqual(p.totals, Object.fromEntries(ACTIVITY.map(k => [k, 0]))); await begin(p); assert.equal((await verify()).verified, true);
    assert.equal((await status()).completed_employees, 0); await noLegacy();
    for (const key of ACTIVITY) assert.equal(await scalar(db, `SELECT count(*)::integer FROM ${RELATIONS[key]}`), 0);
  })); } finally { finance = previous.finance; activity = previous.activity; }
});

console.log(`SQL52 registered ${caseNo} unique cases; selected ${selectedCases}${range ? ` in explicit range ${rangeText}` : ' (whole file)'}. Excluded cases are not passed tests.`);
assert.ok(caseNo >= 35 && caseNo <= 65, 'Keep SQL52 coverage focused at 35–65 unique registered scenarios.');
assert.ok(selectedCases > 0, 'The explicit test range selected no cases.');
if (range) assert.ok(range[1] <= caseNo, `Range ends beyond the ${caseNo} registered cases.`);
